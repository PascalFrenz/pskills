#!/usr/bin/env node
// Keeps the plugin version in every manifest that declares it.
//
//   node scripts/version.mjs current
//       Prints the version; fails if the manifests disagree.
//   node scripts/version.mjs release-type <commit or PR title>
//       Prints major, minor, patch, or none for a Conventional Commits title.
//   node scripts/version.mjs bump <base version> <PR title>
//       Writes the base version raised by the title's release type into every
//       manifest and prints it. A title with no release type writes the base
//       version unchanged, which undoes an earlier bump.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Every field that holds the plugin version, as [file, key path].
export const VERSION_FIELDS = [
  ["plugin.json", ["version"]],
  [".codex-plugin/plugin.json", ["version"]],
  [".claude-plugin/plugin.json", ["version"]],
  [".claude-plugin/marketplace.json", ["metadata", "version"]],
  [".claude-plugin/marketplace.json", ["plugins", 0, "version"]],
  [".github/plugin/marketplace.json", ["metadata", "version"]],
  [".github/plugin/marketplace.json", ["plugins", 0, "version"]],
];

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TITLE = /^(?<type>[a-z]+)(?:\([^)]*\))?(?<breaking>!)?: \S/;
const RELEASE_TYPES = { feat: "minor", fix: "patch", perf: "patch" };
const NO_RELEASE_TYPES = new Set(["build", "chore", "ci", "docs", "refactor", "revert", "style", "test"]);

export class UserError extends Error {}

export function releaseType(title) {
  const match = TITLE.exec(title.trim());
  if (!match) {
    throw new UserError(
      `"${title}" is not a Conventional Commits title, e.g. "feat: add a skill" or "fix(edd): handle empty reports".`,
    );
  }
  const { type, breaking } = match.groups;
  if (breaking) return "major";
  if (type in RELEASE_TYPES) return RELEASE_TYPES[type];
  if (NO_RELEASE_TYPES.has(type)) return "none";
  throw new UserError(
    `Unknown commit type "${type}". Use one of: ${[...Object.keys(RELEASE_TYPES), ...NO_RELEASE_TYPES].join(", ")}.`,
  );
}

export function nextVersion(version, type) {
  const match = SEMVER.exec(version);
  if (!match) throw new UserError(`"${version}" is not a MAJOR.MINOR.PATCH version.`);
  const [major, minor, patch] = match.slice(1).map(Number);
  switch (type) {
    case "major": return `${major + 1}.0.0`;
    case "minor": return `${major}.${minor + 1}.0`;
    case "patch": return `${major}.${minor}.${patch + 1}`;
    case "none": return version;
    default: throw new UserError(`Unknown release type "${type}".`);
  }
}

const readJson = (root, file) => JSON.parse(readFileSync(path.join(root, file), "utf8"));

function fieldOwner(json, keyPath, file) {
  const owner = keyPath.slice(0, -1).reduce((node, key) => node?.[key], json);
  const key = keyPath.at(-1);
  if (typeof owner?.[key] !== "string") {
    throw new UserError(`${file} has no version at ${keyPath.join(".")}.`);
  }
  return { owner, key };
}

export function readVersions(root = repoRoot) {
  return VERSION_FIELDS.map(([file, keyPath]) => {
    const { owner, key } = fieldOwner(readJson(root, file), keyPath, file);
    return { file, keyPath, version: owner[key] };
  });
}

export function currentVersion(root = repoRoot) {
  const versions = readVersions(root);
  const distinct = new Set(versions.map((field) => field.version));
  if (distinct.size !== 1) {
    const listing = versions.map((f) => `  ${f.file} ${f.keyPath.join(".")}: ${f.version}`).join("\n");
    throw new UserError(`Manifest versions disagree:\n${listing}`);
  }
  return versions[0].version;
}

export function writeVersion(version, root = repoRoot) {
  if (!SEMVER.test(version)) throw new UserError(`"${version}" is not a MAJOR.MINOR.PATCH version.`);
  const files = new Map();
  for (const [file, keyPath] of VERSION_FIELDS) {
    if (!files.has(file)) files.set(file, readJson(root, file));
    const { owner, key } = fieldOwner(files.get(file), keyPath, file);
    owner[key] = version;
  }
  for (const [file, json] of files) {
    writeFileSync(path.join(root, file), `${JSON.stringify(json, null, 2)}\n`);
  }
}

export function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  switch (command) {
    case "current":
      return currentVersion();
    case "release-type":
      return releaseType(args.join(" "));
    case "bump": {
      const [base, ...title] = args;
      const version = nextVersion(base ?? "", releaseType(title.join(" ")));
      writeVersion(version);
      return version;
    }
    default:
      throw new UserError("Usage: version.mjs current | release-type <title> | bump <base version> <title>");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${main()}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof UserError ? error.message : error.stack}\n`);
    process.exitCode = 1;
  }
}
