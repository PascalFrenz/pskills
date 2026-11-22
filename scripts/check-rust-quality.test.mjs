import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../skills/edd/scripts/check-rust-quality.py", import.meta.url));
const pythonCandidates = [process.env.EDD_TEST_PYTHON, "python3", "python"].filter(Boolean);
const python = pythonCandidates
  .map((command) => spawnSync(command, ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }))
  .find((result) => result.status === 0)?.stdout.trim();
const cliAvailable = spawnSync("rust-code-analysis-cli", ["--version"]).status === 0;

const branchy = `pub fn classify(value: i32) -> i32 {
    if value == 1 { return 1; }
    if value == 2 { return 2; }
    if value == 3 { return 3; }
    if value == 4 { return 4; }
    if value == 5 { return 5; }
    if value == 6 { return 6; }
    if value == 7 { return 7; }
    if value == 8 { return 8; }
    if value == 9 { return 9; }
    0
}
`;

async function project(context, files) {
  const directory = await mkdtemp(path.join(tmpdir(), "edd rust test "));
  context.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(directory, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return directory;
}

function check(directory, { rules, env = process.env } = {}) {
  const options = rules ? ["--rules", path.join(directory, rules)] : [];
  const result = spawnSync(python, [runner, ...options, directory, "src"], {
    encoding: "utf8",
    env,
    timeout: 60000,
  });
  assert.ifError(result.error);
  return result;
}

const violations = (result) => JSON.parse(result.stdout).files.flatMap((file) => file.violations);

describe("Rust code quality runner", { skip: !python && "Python 3 is not available" }, () => {
  it("fails without rust-code-analysis-cli on PATH", async (context) => {
    const directory = await project(context, { "src/lib.rs": "pub fn one() -> i32 { 1 }\n" });
    const environment = { ...process.env };
    const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
    environment[pathKey] = path.join(directory, "empty");
    const result = check(directory, { env: environment });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /rust-code-analysis-cli is not on PATH/);
  });

  describe("with rust-code-analysis-cli", { skip: !cliAvailable && "rust-code-analysis-cli is not on PATH" }, () => {
    it("prints a clean report and succeeds", async (context) => {
      const directory = await project(context, { "src/lib.rs": "/// Adds one.\npub fn next(value: i32) -> i32 { value + 1 }\n" });
      const result = check(directory);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout).files, []);
      assert.match(result.stderr, /Tool: rust-code-analysis-cli/);
      assert.match(result.stderr, /Sources: 1/);
    });

    it("reports functions at the cyclomatic report level with exit 4", async (context) => {
      const directory = await project(context, { "src/lib.rs": branchy });
      const result = check(directory);
      assert.equal(result.status, 4, result.stderr);
      const [finding] = violations(result).filter((violation) => violation.rule === "CyclomaticComplexity");
      assert.equal(finding.function, "classify");
      assert.equal(finding.value, 10);
      assert.equal(finding.beginLine, 1);
    });

    it("applies cognitive and logical line levels from the rules file and qualifies methods", async (context) => {
      const directory = await project(context, {
        "src/lib.rs": "struct Counter;\nimpl Counter {\n    fn step(&self, a: i32) -> i32 { let b = a + 1; if b > 2 { b } else { a } }\n}\n",
        "rules.json": JSON.stringify({ CognitiveComplexity: { reportLevel: 2 }, LogicalLines: { reportLevel: 2 } }),
      });
      const result = check(directory, { rules: "rules.json" });
      assert.equal(result.status, 4, result.stderr);
      assert.deepEqual(violations(result).map((violation) => [violation.rule, violation.function]), [
        ["CognitiveComplexity", "Counter::step"],
        ["LogicalLines", "Counter::step"],
      ]);
    });

    it("flags inline comments but not doc comments", async (context) => {
      const directory = await project(context, {
        "src/lib.rs": "//! Crate docs.\n/// Item docs.\n/** Block docs. */\npub fn one() -> i32 {\n    // inline\n    /* block */\n    1\n}\n//// not docs\n",
      });
      const result = check(directory);
      assert.equal(result.status, 4, result.stderr);
      assert.deepEqual(violations(result).map((violation) => [violation.rule, violation.beginLine]), [
        ["InlineComment", 5],
        ["InlineComment", 6],
        ["InlineComment", 9],
      ]);
    });

    it("ignores test modules, test functions, and target directories", async (context) => {
      const directory = await project(context, {
        "src/lib.rs": `pub fn one() -> i32 { 1 }\n#[cfg(test)]\n#[allow(dead_code)]\nmod tests {\n    // test comment\n    ${branchy}}\n#[tokio::test(flavor = "current_thread")]\nasync fn checks() {\n    // test comment\n}\n`,
        "src/target/generated.rs": branchy,
      });
      const result = check(directory);
      assert.equal(result.status, 0, result.stdout);
      assert.match(result.stderr, /Sources: 1/);
    });

    it("prints parse errors and fails", async (context) => {
      const directory = await project(context, { "src/lib.rs": "pub fn broken( {\n" });
      const result = check(directory);
      assert.equal(result.status, 2, result.stderr);
      const [error] = JSON.parse(result.stdout).processingErrors;
      assert.match(error.message, /Parse error/);
    });

    it("fails when no Rust sources are found", async (context) => {
      const directory = await project(context, { "src/readme.txt": "none" });
      const result = check(directory);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /No Rust source files/);
    });

    it("rejects unknown rules", async (context) => {
      const directory = await project(context, {
        "src/lib.rs": "pub fn one() -> i32 { 1 }\n",
        "rules.json": JSON.stringify({ NcssCount: { reportLevel: 30 } }),
      });
      const result = check(directory, { rules: "rules.json" });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /Unknown rule NcssCount/);
    });
  });
});
