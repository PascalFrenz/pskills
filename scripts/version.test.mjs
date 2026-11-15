import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  VERSION_FIELDS,
  currentVersion,
  nextVersion,
  releaseType,
  repoRoot,
  writeVersion,
} from "./version.mjs";

// JSON files that hold a version unrelated to the plugin release.
const UNRELATED = new Set(["package.json"]);

function versionKeyPaths(value, prefix = []) {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => versionKeyPaths(item, [...prefix, index]));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) =>
      key === "version" && typeof child === "string"
        ? [[...prefix, key]]
        : versionKeyPaths(child, [...prefix, key]),
    );
  }
  return [];
}

describe("VERSION_FIELDS", () => {
  it("lists exactly the version fields in the tracked manifests", () => {
    const files = execFileSync("git", ["ls-files", "*.json"], { cwd: repoRoot, encoding: "utf8" })
      .split("\n")
      .filter((file) => file && !file.startsWith("skills/") && !UNRELATED.has(file));
    const tracked = files.flatMap((file) =>
      versionKeyPaths(JSON.parse(readFileSync(path.join(repoRoot, file), "utf8"))).map(
        (keyPath) => `${file} ${keyPath.join(".")}`,
      ),
    );
    const listed = VERSION_FIELDS.map(([file, keyPath]) => `${file} ${keyPath.join(".")}`);

    assert.deepEqual(listed.sort(), tracked.sort());
  });

  it("holds one version across every manifest", () => {
    assert.match(currentVersion(), /^\d+\.\d+\.\d+$/);
  });
});

describe("releaseType", () => {
  for (const [title, expected] of [
    ["feat: add a skill", "minor"],
    ["feat(edd): check cognitive complexity", "minor"],
    ["fix: handle empty reports", "patch"],
    ["perf: cache lookups", "patch"],
    ["feat!: drop Codex support", "major"],
    ["fix(edd)!: rename the runner", "major"],
    ["chore: refresh vendored skills", "none"],
    ["ci: run tests on pull requests", "none"],
    ["docs: explain releases", "none"],
  ]) {
    it(`maps "${title}" to ${expected}`, () => assert.equal(releaseType(title), expected));
  }

  it("rejects a title that is not a Conventional Commit", () => {
    assert.throws(() => releaseType("Add a skill"), /not a Conventional Commits title/);
  });

  it("rejects an unknown commit type", () => {
    assert.throws(() => releaseType("feature: add a skill"), /Unknown commit type "feature"/);
  });
});

describe("nextVersion", () => {
  it("raises the requested part and resets the lower ones", () => {
    assert.equal(nextVersion("1.3.2", "major"), "2.0.0");
    assert.equal(nextVersion("1.3.2", "minor"), "1.4.0");
    assert.equal(nextVersion("1.3.2", "patch"), "1.3.3");
    assert.equal(nextVersion("1.3.2", "none"), "1.3.2");
  });

  it("rejects a malformed version", () => {
    assert.throws(() => nextVersion("v1.3", "patch"), /not a MAJOR\.MINOR\.PATCH version/);
  });
});

describe("writeVersion", () => {
  it("changes only the version lines of every manifest", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pskills-version-"));
    try {
      const files = [...new Set(VERSION_FIELDS.map(([file]) => file))];
      for (const file of files) cpSync(path.join(repoRoot, file), path.join(root, file));
      const before = currentVersion(root);

      writeVersion("9.8.7", root);

      assert.equal(currentVersion(root), "9.8.7");
      for (const file of files) {
        const original = readFileSync(path.join(repoRoot, file), "utf8");
        const written = readFileSync(path.join(root, file), "utf8");
        assert.equal(written, original.replaceAll(`"version": "${before}"`, '"version": "9.8.7"'), file);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
