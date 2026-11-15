import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { repoRoot } from "./fetch-skills.mjs";

const readJson = async (relativePath) =>
  JSON.parse(await readFile(path.join(repoRoot, relativePath), "utf8"));

// Files that hold a version but are not the plugin's release version.
const IGNORED = new Set(["package.json", ".release-please-manifest.json"]);

// Every `version` key in a JSON value, as release-please jsonpaths.
function versionPaths(value, prefix = "$") {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => versionPaths(item, `${prefix}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) =>
      key === "version" && typeof child === "string"
        ? [`${prefix}.${key}`]
        : versionPaths(child, `${prefix}.${key}`),
    );
  }
  return [];
}

async function trackedVersionFields() {
  const files = execFileSync("git", ["ls-files", "*.json"], { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .filter((file) => file && !file.startsWith("skills/") && !IGNORED.has(file));
  const fields = [];
  for (const file of files) {
    for (const jsonpath of versionPaths(await readJson(file))) {
      fields.push({ path: file, jsonpath });
    }
  }
  return fields;
}

describe("release-please config", () => {
  it("bumps every version field in the plugin and marketplace manifests", async () => {
    const config = await readJson("release-please-config.json");
    const configured = config.packages["."]["extra-files"].map(
      (entry) => `${entry.path} ${entry.jsonpath}`,
    );
    const actual = (await trackedVersionFields()).map(
      (field) => `${field.path} ${field.jsonpath}`,
    );

    assert.deepEqual(
      [...configured].sort(),
      [...actual].sort(),
      "release-please-config.json extra-files must list exactly the tracked version fields",
    );
  });

  it("keeps every version field at the released version", async () => {
    const released = (await readJson(".release-please-manifest.json"))["."];
    const versionTxt = (await readFile(path.join(repoRoot, "version.txt"), "utf8")).trim();
    assert.equal(versionTxt, released, "version.txt must match .release-please-manifest.json");

    for (const field of await trackedVersionFields()) {
      const json = await readJson(field.path);
      const segments = field.jsonpath.slice(2).split(/\.|\[(\d+)\]/).filter(Boolean);
      const value = segments.reduce((node, key) => node[key], json);
      assert.equal(value, released, `${field.path} ${field.jsonpath} is not ${released}`);
    }
  });
});
