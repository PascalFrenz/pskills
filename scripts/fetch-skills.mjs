#!/usr/bin/env node
/**
 * Fetch or update vendored agent skills from upstream repositories.
 *
 * Config is a JSON array of { sourceUrl, targetPath } entries. A directory
 * source claims its target directory exclusively: files that disappear
 * upstream are pruned locally, so a vendored skill always matches one
 * upstream commit rather than an accumulation of several.
 */

import { parseArgs } from "node:util";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";

const GITHUB_API = "https://api.github.com";
const RAW_HOST = "https://raw.githubusercontent.com";
const REQUEST_TIMEOUT_MS = 30_000;
const CONCURRENCY = 8;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const WINDOWS_RESERVED = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export class UserError extends Error {}

// --- config parsing -------------------------------------------------------

export function parseSourceUrl(sourceUrl) {
  let url;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new UserError(`sourceUrl is not a valid URL: ${sourceUrl}`);
  }
  if (url.protocol !== "https:") {
    throw new UserError(`sourceUrl must use https: ${sourceUrl}`);
  }

  if (url.host === "github.com") {
    const segments = decodeSegments(url.pathname);
    const [owner, repo, kindSegment, ...rest] = segments;
    if (!owner || !repo || (kindSegment !== "tree" && kindSegment !== "blob")) {
      throw new UserError(
        `unsupported github.com URL, expected /{owner}/{repo}/(tree|blob)/{ref}/{path}: ${sourceUrl}`,
      );
    }
    if (rest.length < 2) {
      throw new UserError(`github.com URL is missing a ref or path: ${sourceUrl}`);
    }
    return {
      kind: kindSegment === "tree" ? "dir" : "file",
      host: "github",
      owner,
      repo,
      // The ref/path split is ambiguous because refs may contain slashes,
      // so it is resolved against the remote later.
      tail: rest,
      sourceUrl,
    };
  }

  if (url.host === "raw.githubusercontent.com") {
    const segments = decodeSegments(url.pathname);
    const [owner, repo, ref, ...filePath] = segments;
    if (!owner || !repo || !ref || filePath.length === 0) {
      throw new UserError(
        `unsupported raw.githubusercontent.com URL, expected /{owner}/{repo}/{ref}/{path}: ${sourceUrl}`,
      );
    }
    return { kind: "file", host: "raw", sourceUrl, downloadUrl: sourceUrl };
  }

  return { kind: "file", host: "other", sourceUrl, downloadUrl: sourceUrl };
}

function decodeSegments(pathname) {
  return pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
}

export function validateTargetPath(targetPath) {
  if (typeof targetPath !== "string" || targetPath.trim() === "") {
    throw new UserError("targetPath must be a non-empty string");
  }
  if (targetPath.includes("\\")) {
    throw new UserError(`targetPath must use forward slashes: ${targetPath}`);
  }
  if (targetPath.endsWith("/")) {
    throw new UserError(
      `targetPath must not end with a slash, the kind is derived from sourceUrl: ${targetPath}`,
    );
  }
  if (targetPath.startsWith("/") || /^[A-Za-z]:/.test(targetPath)) {
    throw new UserError(`targetPath must be relative to the repo root: ${targetPath}`);
  }

  const segments = targetPath.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new UserError(`targetPath contains an invalid segment: ${targetPath}`);
    }
    if (segment.endsWith(".") || segment.endsWith(" ")) {
      throw new UserError(
        `targetPath segment must not end with a dot or space: ${targetPath}`,
      );
    }
    const stem = segment.split(".")[0].toLowerCase();
    if (WINDOWS_RESERVED.has(stem)) {
      throw new UserError(`targetPath uses a Windows-reserved name: ${targetPath}`);
    }
  }
  return segments.join("/");
}

export function validateConfig(raw) {
  if (!Array.isArray(raw)) {
    throw new UserError("config must be a JSON array of entries");
  }
  const errors = [];
  const entries = [];

  raw.forEach((entry, index) => {
    const label = `entry[${index}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${label}: must be an object`);
      return;
    }
    const unknown = Object.keys(entry).filter(
      (key) => key !== "sourceUrl" && key !== "targetPath",
    );
    if (unknown.length > 0) {
      errors.push(`${label}: unknown keys: ${unknown.join(", ")}`);
    }
    try {
      if (typeof entry.sourceUrl !== "string" || entry.sourceUrl.trim() === "") {
        throw new UserError("sourceUrl must be a non-empty string");
      }
      const source = parseSourceUrl(entry.sourceUrl);
      const targetPath = validateTargetPath(entry.targetPath);
      entries.push({ index, source, targetPath });
    } catch (error) {
      errors.push(`${label}: ${error.message}`);
    }
  });

  errors.push(...findTargetOverlaps(entries));
  if (errors.length > 0) {
    throw new UserError(`invalid config:\n  ${errors.join("\n  ")}`);
  }
  return entries;
}

/**
 * Rejects targets that write into each other. Comparison is case-insensitive
 * so a config authored on Linux cannot silently collide on Windows.
 */
export function findTargetOverlaps(entries) {
  const errors = [];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i].targetPath.toLowerCase();
      const b = entries[j].targetPath.toLowerCase();
      if (a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`)) {
        errors.push(
          `entry[${entries[i].index}] and entry[${entries[j].index}] have overlapping targetPath: ` +
            `${entries[i].targetPath} / ${entries[j].targetPath}`,
        );
      }
    }
  }
  return errors;
}

/**
 * Picks the longest ref that is a whole-segment prefix of the URL tail.
 * `candidates` carry full ref names such as `refs/heads/release/1.0`.
 */
export function selectRef(tail, candidates) {
  const matches = [];
  for (const candidate of candidates) {
    const name = candidate.ref.replace(/^refs\/(heads|tags)\//, "");
    const segments = name.split("/");
    const isPrefix = segments.every((segment, index) => tail[index] === segment);
    if (isPrefix && tail.length > segments.length) {
      matches.push({ ...candidate, name, segments });
    }
  }
  if (matches.length === 0) return null;

  const longest = Math.max(...matches.map((match) => match.segments.length));
  const best = matches.filter((match) => match.segments.length === longest);
  if (best.length > 1) {
    throw new UserError(
      `ambiguous ref, several refs match ${tail.join("/")}: ${best
        .map((match) => match.ref)
        .join(", ")}`,
    );
  }
  const [match] = best;
  return {
    ref: match.name,
    sha: match.sha,
    type: match.type,
    path: tail.slice(longest).join("/"),
  };
}

// --- github access --------------------------------------------------------

/**
 * Picks a token that actually belongs to github.com. `GH_TOKEN` is skipped
 * when `GH_HOST` points at a GitHub Enterprise instance, because an
 * enterprise token is rejected by api.github.com with a 401.
 */
export function githubToken(env = process.env) {
  if (env.PSKILLS_GITHUB_TOKEN) return env.PSKILLS_GITHUB_TOKEN;
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  const host = env.GH_HOST?.trim().toLowerCase();
  if (env.GH_TOKEN && (!host || host === "github.com")) return env.GH_TOKEN;
  return null;
}

function githubHeaders(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "pskills-fetch-skills",
  };
  // Scoped to api.github.com only; never sent to arbitrary download hosts.
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

let authDisabled = false;

async function githubApi(pathname) {
  const token = authDisabled ? null : githubToken();
  const response = await fetch(`${GITHUB_API}${pathname}`, {
    headers: githubHeaders(token),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  // A stale or foreign token must not block access to public repositories.
  if (response.status === 401 && token) {
    authDisabled = true;
    process.stderr.write(
      "warning: GitHub token rejected (401), continuing unauthenticated\n",
    );
    return githubApi(pathname);
  }

  if (
    (response.status === 403 || response.status === 429) &&
    response.headers.get("x-ratelimit-remaining") === "0"
  ) {
    const reset = response.headers.get("x-ratelimit-reset");
    const when = reset ? new Date(Number(reset) * 1000).toISOString() : "unknown";
    throw new UserError(
      `GitHub rate limit exhausted (resets ${when}). ` +
        "Set PSKILLS_GITHUB_TOKEN to a github.com token to raise the limit.",
    );
  }
  if (!response.ok) {
    throw new Error(`GET ${pathname} failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

const refCache = new Map();

async function resolveGithubRef(source) {
  const [first] = source.tail;
  if (SHA_PATTERN.test(first)) {
    return { ref: first, sha: first, path: source.tail.slice(1).join("/") };
  }

  const cacheKey = `${source.owner}/${source.repo}#${first}`;
  if (!refCache.has(cacheKey)) {
    refCache.set(cacheKey, loadMatchingRefs(source.owner, source.repo, first));
  }
  const candidates = await refCache.get(cacheKey);

  const selected = selectRef(source.tail, candidates);
  if (!selected) {
    throw new UserError(
      `could not resolve a ref for ${source.sourceUrl}. ` +
        `No branch or tag starting with "${first}" contains this path.`,
    );
  }
  const sha = await peelTag(source.owner, source.repo, selected);
  return { ...selected, sha };
}

async function loadMatchingRefs(owner, repo, prefix) {
  const encoded = encodeURIComponent(prefix);
  const [heads, tags] = await Promise.all([
    githubApi(`/repos/${owner}/${repo}/git/matching-refs/heads/${encoded}`),
    githubApi(`/repos/${owner}/${repo}/git/matching-refs/tags/${encoded}`),
  ]);
  return [...heads, ...tags].map((entry) => ({
    ref: entry.ref,
    sha: entry.object.sha,
    type: entry.object.type,
  }));
}

async function peelTag(owner, repo, selected) {
  if (selected.type !== "tag") return selected.sha;
  const tag = await githubApi(`/repos/${owner}/${repo}/git/tags/${selected.sha}`);
  return tag.object.sha;
}

/**
 * Lists blobs under a subtree. Requesting `{sha}:{path}` keeps the response
 * scoped to the skill directory, so unrelated parts of a large repo cannot
 * truncate it away. Returned paths are relative to that subtree.
 */
async function listSubtree(owner, repo, sha, subPath) {
  const treeish = subPath ? `${sha}:${subPath}` : sha;
  const tree = await githubApi(
    `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(treeish)}?recursive=1`,
  );
  if (!tree.truncated) {
    return tree.tree.filter((node) => node.type === "blob").map((node) => node.path);
  }
  return walkTree(owner, repo, tree.sha, "");
}

async function walkTree(owner, repo, treeSha, prefix) {
  const tree = await githubApi(`/repos/${owner}/${repo}/git/trees/${treeSha}`);
  const files = [];
  for (const node of tree.tree) {
    const nodePath = prefix ? `${prefix}/${node.path}` : node.path;
    if (node.type === "blob") {
      files.push(nodePath);
    } else if (node.type === "tree") {
      files.push(...(await walkTree(owner, repo, node.sha, nodePath)));
    }
  }
  return files;
}

export function rawUrl(owner, repo, sha, filePath) {
  const encoded = filePath.split("/").map(encodeURIComponent).join("/");
  return `${RAW_HOST}/${owner}/${repo}/${sha}/${encoded}`;
}

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

// --- filesystem -----------------------------------------------------------

/**
 * Guards against writing outside the repo, including through an existing
 * symlink or junction in the target's ancestry.
 */
async function assertInsideRepo(absolutePath) {
  const relative = path.relative(repoRoot, absolutePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new UserError(`targetPath escapes the repo root: ${absolutePath}`);
  }

  let current = path.dirname(absolutePath);
  while (current !== repoRoot && current !== path.dirname(current)) {
    let info = null;
    try {
      info = await lstat(current);
    } catch {
      current = path.dirname(current);
      continue;
    }
    if (info.isSymbolicLink()) {
      const resolved = await realpath(current);
      const resolvedRelative = path.relative(repoRoot, resolved);
      if (resolvedRelative.startsWith("..") || path.isAbsolute(resolvedRelative)) {
        throw new UserError(`targetPath resolves outside the repo via a link: ${current}`);
      }
    }
    current = path.dirname(current);
  }
}

async function readIfExists(absolutePath) {
  try {
    return await readFile(absolutePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeAtomic(absolutePath, contents) {
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const temp = `${absolutePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temp, contents);
    await renameWithRetry(temp, absolutePath);
  } finally {
    await rm(temp, { force: true });
  }
}

// Windows can transiently fail a rename while an indexer holds the target.
async function renameWithRetry(from, to, attempts = 3) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (attempt >= attempts || (error.code !== "EPERM" && error.code !== "EBUSY")) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}

async function listFilesRecursive(absoluteDir) {
  const files = [];
  let dirEntries;
  try {
    dirEntries = await readdir(absoluteDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return files;
    throw error;
  }
  for (const dirEntry of dirEntries) {
    const child = path.join(absoluteDir, dirEntry.name);
    if (dirEntry.isDirectory()) {
      files.push(...(await listFilesRecursive(child)));
    } else {
      files.push(child);
    }
  }
  return files;
}

async function removeEmptyDirs(absoluteDir, stopAt) {
  let current = absoluteDir;
  while (current !== stopAt && current.startsWith(stopAt)) {
    const remaining = await readdir(current).catch(() => null);
    if (remaining === null || remaining.length > 0) return;
    await rmdir(current).catch(() => {});
    current = path.dirname(current);
  }
}

// --- entry processing -----------------------------------------------------

async function planEntry(entry) {
  const { source, targetPath } = entry;
  if (source.kind === "file") {
    if (source.host === "github") {
      const { sha, path: filePath } = await resolveGithubRef(source);
      if (!filePath) {
        throw new UserError(`github blob URL is missing a file path: ${source.sourceUrl}`);
      }
      return {
        entry,
        files: [{ url: rawUrl(source.owner, source.repo, sha, filePath), targetPath }],
      };
    }
    return { entry, files: [{ url: source.downloadUrl, targetPath }] };
  }

  const { sha, path: dirPath } = await resolveGithubRef(source);
  const blobs = await listSubtree(source.owner, source.repo, sha, dirPath);
  if (blobs.length === 0) {
    throw new UserError(`no files found under ${source.sourceUrl}`);
  }
  return {
    entry,
    files: blobs.map((relativePath) => ({
      url: rawUrl(
        source.owner,
        source.repo,
        sha,
        dirPath ? `${dirPath}/${relativePath}` : relativePath,
      ),
      targetPath: `${targetPath}/${relativePath}`,
    })),
  };
}

/**
 * Downloads every file of an entry before writing any of them, so a partial
 * network failure cannot leave half of a vendored skill updated.
 */
async function fetchEntry(plan) {
  const files = await mapLimit(plan.files, CONCURRENCY, async (file) => ({
    ...file,
    contents: await download(file.url),
  }));
  return { ...plan, files };
}

async function applyEntry(plan, { dryRun }) {
  const stats = { added: 0, updated: 0, unchanged: 0, deleted: 0 };
  const changes = [];

  for (const file of plan.files) {
    const absolutePath = path.resolve(repoRoot, file.targetPath);
    await assertInsideRepo(absolutePath);
    const existing = await readIfExists(absolutePath);
    const status =
      existing === null ? "added" : existing.equals(file.contents) ? "unchanged" : "updated";
    stats[status] += 1;
    if (status !== "unchanged") {
      changes.push(`  ${status.padEnd(9)} ${file.targetPath}`);
      if (!dryRun) await writeAtomic(absolutePath, file.contents);
    }
  }

  if (plan.entry.source.kind === "dir") {
    const targetDir = path.resolve(repoRoot, plan.entry.targetPath);
    await assertInsideRepo(targetDir);
    const managed = new Set(plan.files.map((file) => path.resolve(repoRoot, file.targetPath)));
    for (const existingFile of await listFilesRecursive(targetDir)) {
      if (managed.has(existingFile)) continue;
      stats.deleted += 1;
      changes.push(
        `  deleted   ${path.relative(repoRoot, existingFile).split(path.sep).join("/")}`,
      );
      if (!dryRun) {
        await rm(existingFile, { force: true });
        await removeEmptyDirs(path.dirname(existingFile), targetDir);
      }
    }
  }

  return { stats, changes };
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

// --- cli ------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: "string", default: "skills.config.json" },
      filter: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(
      "Usage: node scripts/fetch-skills.mjs [options]\n\n" +
        "  --config <path>    config file (default: skills.config.json)\n" +
        "  --filter <substr>  only entries whose sourceUrl or targetPath match\n" +
        "  --dry-run          resolve and report without writing\n" +
        "  --verbose          also report entries with no changes\n",
    );
    return 0;
  }

  const configPath = path.resolve(repoRoot, values.config);
  const raw = await readFile(configPath, "utf8").catch(() => {
    throw new UserError(`config not found: ${configPath}`);
  });

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new UserError(`config is not valid JSON: ${error.message}`);
  }

  let entries = validateConfig(parsed);
  if (values.filter) {
    const needle = values.filter.toLowerCase();
    entries = entries.filter(
      (entry) =>
        entry.targetPath.toLowerCase().includes(needle) ||
        entry.source.sourceUrl.toLowerCase().includes(needle),
    );
  }

  if (entries.length === 0) {
    process.stdout.write("no entries to fetch\n");
    return 0;
  }

  const totals = { added: 0, updated: 0, unchanged: 0, deleted: 0 };
  const failures = [];

  for (const entry of entries) {
    try {
      const plan = await planEntry(entry);
      const fetched = await fetchEntry(plan);
      const { stats, changes } = await applyEntry(fetched, { dryRun: values["dry-run"] });
      for (const key of Object.keys(totals)) totals[key] += stats[key];
      if (changes.length > 0) {
        process.stdout.write(`${entry.source.sourceUrl}\n${changes.join("\n")}\n`);
      } else if (values.verbose) {
        process.stdout.write(`${entry.source.sourceUrl}\n  unchanged (${stats.unchanged})\n`);
      }
    } catch (error) {
      failures.push(`${entry.source.sourceUrl}: ${error.message}`);
    }
  }

  const prefix = values["dry-run"] ? "dry-run: " : "";
  process.stdout.write(
    `${prefix}${totals.added} added, ${totals.updated} updated, ` +
      `${totals.unchanged} unchanged, ${totals.deleted} deleted\n`,
  );

  if (failures.length > 0) {
    process.stderr.write(`\n${failures.length} entry failed:\n  ${failures.join("\n  ")}\n`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof UserError ? error.message : error.stack}\n`);
      process.exitCode = 1;
    });
}
