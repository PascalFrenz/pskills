import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const runnerDirectory = fileURLToPath(new URL("../skills/edd/scripts/", import.meta.url));
const slashPath = (filePath) => filePath.replaceAll("\\", "/");
const cleanReport = { files: [], processingErrors: [], configurationErrors: [] };
const findingsReport = {
  ...cleanReport,
  files: [{
    filename: "Booking.java",
    violations: [{ rule: "CognitiveComplexity", description: "Booking complexity exceeds 15" }],
  }],
};
const runners = [
  { name: "PowerShell", command: "pwsh", args: ["-NoProfile", "-File", path.join(runnerDirectory, "check-code-quality.ps1")] },
  { name: "Bash", command: process.env.PMD_TEST_BASH || (process.platform === "win32" ? null : "bash"), args: [slashPath(path.join(runnerDirectory, "check-code-quality.sh"))] },
];
const cases = [
  { name: "prints a clean report and succeeds", report: cleanReport, pmdExit: 0, expectedExit: 0 },
  { name: "prints findings and preserves exit 4", report: findingsReport, pmdExit: 4, expectedExit: 4 },
  { name: "prints processing errors and fails", report: { ...cleanReport, processingErrors: [{ message: "Parse failed" }] }, pmdExit: 0, expectedExit: 2 },
  { name: "prints configuration errors and fails", report: { ...cleanReport, configurationErrors: [{ issue: "Unknown rule" }] }, pmdExit: 0, expectedExit: 2 },
  { name: "rejects an invalid report shape", report: { files: "invalid" }, pmdExit: 0, expectedExit: 2 },
  { name: "rejects malformed JSON", rawReport: "not JSON", pmdExit: 0, expectedExit: 2 },
  { name: "rejects missing output", rawReport: "", pmdExit: 0, expectedExit: 2 },
  { name: "prints PMD failure output before failing", report: findingsReport, pmdExit: 5, expectedExit: 2 },
  { name: "fails when PMD's lib directory for the skill-owned rules is missing", defaultRuleset: true, report: cleanReport, pmdExit: 0, expectedExit: 2 },
];

for (const runner of runners) {
  const available = runner.command && spawnSync(runner.command, ["--version"]).status === 0;
  describe(`${runner.name} code quality stdout`, { skip: !available }, () => {
    for (const scenario of cases) {
      it(scenario.name, async (context) => {
        const directory = await mkdtemp(path.join(tmpdir(), "edd stdout test "));
        context.after(() => rm(directory, { recursive: true, force: true }));
        const source = path.join(directory, "Booking.java");
        await writeFile(source, "class Booking {}\n");
        const ruleset = path.join(directory, "stub-rules.xml");
        await writeFile(ruleset, '<ruleset name="stub" xmlns="http://pmd.sourceforge.net/ruleset/2.0.0"/>\n');
        const stub = path.join(directory, "pmd-stub.mjs");
        await writeFile(stub, `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("PMD 7.28.0");
  process.exit(0);
}
assert.ok(!args.includes("--report-file"));
assert.equal(args[args.indexOf("--format") + 1], "json");
assert.ok(args.includes("--show-suppressed"));
assert.ok(args.includes("--fail-on-error"));
assert.ok(args.includes("--fail-on-violation"));
assert.ok(readFileSync(args[args.indexOf("--file-list") + 1], "utf8").includes("Booking.java"));
process.stdout.write(process.env.PMD_TEST_OUTPUT);
process.exit(Number(process.env.PMD_TEST_EXIT));
`);
        await writeFile(path.join(directory, "pmd.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0pmd-stub.mjs" %*\r\n`);
        await writeFile(path.join(directory, "pmd"), `#!/usr/bin/env bash\nexec "${slashPath(process.execPath)}" "${slashPath(stub)}" "$@"\n`, { mode: 0o755 });
        if (process.env.PMD_TEST_PYTHON) {
          await writeFile(path.join(directory, "python3"), `#!/usr/bin/env bash\nexec "${slashPath(process.env.PMD_TEST_PYTHON)}" "$@"\n`, { mode: 0o755 });
        }
        const rawReport = scenario.rawReport ?? JSON.stringify(scenario.report);
        const environment = { ...process.env };
        const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
        environment[pathKey] = `${directory}${path.delimiter}${environment[pathKey] ?? ""}`;
        Object.assign(environment, {
          PMD_TEST_OUTPUT: rawReport,
          PMD_TEST_EXIT: String(scenario.pmdExit),
          TEMP: directory,
          TMP: directory,
          TMPDIR: slashPath(directory),
        });
        delete environment.PMD_HOME;
        if (!scenario.defaultRuleset) {
          environment.PMD_RULESET = slashPath(ruleset);
        }
        const rulesetArguments = scenario.defaultRuleset ? [] : ["-Ruleset", ruleset];
        const argumentsForProject = runner.name === "PowerShell"
          ? ["-ProjectDirectory", directory, "-SourceDirectory", directory, ...rulesetArguments]
          : [slashPath(directory), slashPath(directory)];
        const result = spawnSync(runner.command, [...runner.args, ...argumentsForProject], {
          env: environment,
          encoding: "utf8",
          timeout: 30000,
        });
        assert.ifError(result.error);
        assert.equal(result.status, scenario.expectedExit, result.stderr);
        if (scenario.defaultRuleset) {
          assert.equal(result.stdout, "");
          assert.match(result.stderr, /PMD_HOME|javac/);
          return;
        }
        assert.equal(result.stdout.trim(), rawReport);
        if (scenario.report) {
          assert.deepEqual(JSON.parse(result.stdout), scenario.report);
        }
        assert.match(result.stderr, /PMD: PMD 7\.28\.0/);
        assert.match(result.stderr, /Sources: 1/);
        const generatedFiles = await readdir(directory, { recursive: true });
        assert.ok(!generatedFiles.some((filePath) => filePath.endsWith("report.json")));
      });
    }
  });
}
