import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import {
  findTargetOverlaps,
  githubToken,
  parseSourceUrl,
  rawUrl,
  repoRoot,
  selectRef,
  validateConfig,
  validateTargetPath,
} from "./fetch-skills.mjs";

const readJson = async (relativePath) =>
  JSON.parse(await readFile(path.join(repoRoot, relativePath), "utf8"));

describe("parseSourceUrl", () => {
  it("classifies a github tree URL as a directory", () => {
    const source = parseSourceUrl(
      "https://github.com/mattpocock/skills/tree/main/skills/engineering/tdd",
    );
    assert.equal(source.kind, "dir");
    assert.equal(source.host, "github");
    assert.equal(source.owner, "mattpocock");
    assert.equal(source.repo, "skills");
    assert.deepEqual(source.tail, ["main", "skills", "engineering", "tdd"]);
  });

  it("classifies a github blob URL as a file", () => {
    const source = parseSourceUrl(
      "https://github.com/cursor/plugins/blob/main/pstack/skills/why/SKILL.md",
    );
    assert.equal(source.kind, "file");
    assert.deepEqual(source.tail, ["main", "pstack", "skills", "why", "SKILL.md"]);
  });

  it("accepts a raw.githubusercontent URL as a direct download", () => {
    const url = "https://raw.githubusercontent.com/o/r/main/a/b.md";
    const source = parseSourceUrl(url);
    assert.equal(source.kind, "file");
    assert.equal(source.downloadUrl, url);
  });

  it("treats any other https URL as a plain file download", () => {
    const source = parseSourceUrl("https://example.com/some/skill.md");
    assert.equal(source.kind, "file");
    assert.equal(source.host, "other");
  });

  it("rejects non-https and malformed github URLs", () => {
    assert.throws(() => parseSourceUrl("http://github.com/o/r/tree/main/x"), /must use https/);
    assert.throws(() => parseSourceUrl("https://github.com/o/r"), /unsupported github.com URL/);
    assert.throws(() => parseSourceUrl("https://github.com/o/r/tree/main"), /missing a ref or path/);
  });
});

describe("validateTargetPath", () => {
  it("accepts a relative posix path", () => {
    assert.equal(validateTargetPath("skills/tdd/SKILL.md"), "skills/tdd/SKILL.md");
  });

  it("rejects paths that would surprise or escape", () => {
    const cases = [
      ["skills\\tdd", /forward slashes/],
      ["skills/tdd/", /must not end with a slash/],
      ["/skills/tdd", /relative to the repo root/],
      ["C:/skills/tdd", /relative to the repo root/],
      ["skills/../../etc", /invalid segment/],
      ["skills/tdd.", /dot or space/],
      ["skills/nul.md", /Windows-reserved/],
      ["", /non-empty string/],
    ];
    for (const [input, pattern] of cases) {
      assert.throws(() => validateTargetPath(input), pattern, `expected ${input} to be rejected`);
    }
  });
});

describe("findTargetOverlaps", () => {
  const entry = (index, targetPath) => ({ index, targetPath });

  it("reports identical targets", () => {
    const errors = findTargetOverlaps([entry(0, "skills/a"), entry(1, "skills/a")]);
    assert.equal(errors.length, 1);
  });

  it("reports a file target nested inside a directory target", () => {
    const errors = findTargetOverlaps([entry(0, "skills/a"), entry(1, "skills/a/SKILL.md")]);
    assert.equal(errors.length, 1);
  });

  it("reports case-only collisions so linux configs stay windows-safe", () => {
    const errors = findTargetOverlaps([entry(0, "skills/A"), entry(1, "skills/a")]);
    assert.equal(errors.length, 1);
  });

  it("allows sibling targets", () => {
    assert.deepEqual(findTargetOverlaps([entry(0, "skills/a"), entry(1, "skills/ab")]), []);
  });
});

describe("selectRef", () => {
  const ref = (name, sha = "sha-" + name) => ({ ref: `refs/heads/${name}`, sha, type: "commit" });

  it("splits a simple ref from the path", () => {
    const selected = selectRef(["main", "skills", "tdd"], [ref("main")]);
    assert.equal(selected.ref, "main");
    assert.equal(selected.path, "skills/tdd");
  });

  it("prefers the longest ref when a ref name contains slashes", () => {
    const selected = selectRef(["release", "1.0", "skills"], [ref("release"), ref("release/1.0")]);
    assert.equal(selected.ref, "release/1.0");
    assert.equal(selected.path, "skills");
  });

  it("only matches on whole segments", () => {
    assert.equal(selectRef(["main", "skills"], [ref("mai")]), null);
  });

  it("throws when a branch and a tag of the same name both match", () => {
    const candidates = [
      { ref: "refs/heads/v1", sha: "a", type: "commit" },
      { ref: "refs/tags/v1", sha: "b", type: "tag" },
    ];
    assert.throws(() => selectRef(["v1", "skills"], candidates), /ambiguous ref/);
  });

  it("returns null when no candidate leaves a path behind", () => {
    assert.equal(selectRef(["main"], [ref("main")]), null);
  });
});

describe("rawUrl", () => {
  it("encodes each path segment separately", () => {
    assert.equal(
      rawUrl("o", "r", "abc", "a dir/b#c.md"),
      "https://raw.githubusercontent.com/o/r/abc/a%20dir/b%23c.md",
    );
  });
});

describe("githubToken", () => {
  it("prefers the dedicated variable", () => {
    assert.equal(
      githubToken({ PSKILLS_GITHUB_TOKEN: "a", GITHUB_TOKEN: "b", GH_TOKEN: "c" }),
      "a",
    );
  });

  it("ignores GH_TOKEN when GH_HOST is a github enterprise instance", () => {
    assert.equal(githubToken({ GH_TOKEN: "c", GH_HOST: "acme.ghe.com" }), null);
  });

  it("uses GH_TOKEN when no enterprise host is configured", () => {
    assert.equal(githubToken({ GH_TOKEN: "c" }), "c");
    assert.equal(githubToken({ GH_TOKEN: "c", GH_HOST: "github.com" }), "c");
  });

  it("returns null when nothing is set", () => {
    assert.equal(githubToken({}), null);
  });
});

describe("validateConfig", () => {
  it("returns parsed entries for a valid config", () => {
    const entries = validateConfig([
      { sourceUrl: "https://github.com/o/r/tree/main/a", targetPath: "skills/a" },
    ]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].source.kind, "dir");
  });

  it("rejects a non-array config", () => {
    assert.throws(() => validateConfig({}), /must be a JSON array/);
  });

  it("rejects unknown keys and reports every problem at once", () => {
    assert.throws(
      () =>
        validateConfig([
          { sourceUrl: "https://github.com/o/r/tree/main/a", targetPath: "a", ref: "main" },
          { sourceUrl: "", targetPath: "b" },
        ]),
      /unknown keys: ref[\s\S]*non-empty string/,
    );
  });
});

describe("plugin manifest", () => {
  it("keeps the Codex and Copilot plugin identities aligned", async () => {
    const plugin = await readJson("plugin.json");
    const codexPlugin = await readJson(".codex-plugin/plugin.json");
    const marketplace = await readJson(".github/plugin/marketplace.json");
    const listed = marketplace.plugins.find((entry) => entry.name === plugin.name);

    assert.ok(listed, `marketplace.json does not list the plugin "${plugin.name}"`);
    assert.equal(codexPlugin.name, plugin.name, "keep both plugin names aligned");
    assert.equal(
      listed.version,
      plugin.version,
      "bump the version in plugin.json and marketplace.json together",
    );
    assert.equal(
      codexPlugin.version,
      plugin.version,
      "bump the version in both plugin manifests together",
    );
    assert.equal(
      codexPlugin.skills.replace(/^\.\//, ""),
      plugin.skills,
      "both plugin manifests must package the same skills directory",
    );
  });

  it("points the marketplace entry at the plugin manifest directory", async () => {
    const marketplace = await readJson(".github/plugin/marketplace.json");
    const [listed] = marketplace.plugins;
    assert.equal(listed.source, ".", "plugin.json lives at the repo root");
  });

  it("keeps every configured target inside the declared skills directory", async () => {
    const plugin = await readJson("plugin.json");
    const entries = validateConfig(await readJson("skills.config.json"));
    const skillsDir = plugin.skills.replace(/\/$/, "");

    for (const entry of entries) {
      assert.ok(
        entry.targetPath.startsWith(`${skillsDir}/`),
        `${entry.targetPath} is outside ${skillsDir}/ and would not ship with the plugin`,
      );
    }
  });
});

describe("original skills", () => {
  it("never lets a config entry claim the whole skills directory", async () => {
    const plugin = await readJson("plugin.json");
    const skillsDir = plugin.skills.replace(/\/$/, "");
    const entries = validateConfig(await readJson("skills.config.json"));

    for (const entry of entries) {
      assert.notEqual(
        entry.targetPath,
        skillsDir,
        `a directory target of "${skillsDir}" is vendor-owned and would prune hand-written skills`,
      );
    }
  });

  it("leaves hand-written skills outside every vendored target", async () => {
    const plugin = await readJson("plugin.json");
    const skillsDir = plugin.skills.replace(/\/$/, "");
    const entries = validateConfig(await readJson("skills.config.json"));
    const onDisk = await readdir(path.join(repoRoot, skillsDir), { withFileTypes: true });

    const original = onDisk
      .filter((item) => item.isDirectory())
      .map((item) => `${skillsDir}/${item.name}`)
      .filter((dir) => !entries.some((entry) => entry.targetPath.startsWith(dir)));

    for (const dir of original) {
      for (const entry of entries) {
        assert.ok(
          !dir.startsWith(`${entry.targetPath}/`),
          `${dir} is hand-written but sits inside vendored target ${entry.targetPath}`,
        );
      }
    }
    assert.ok(original.length > 0, "expected at least one hand-written skill");
  });
});
