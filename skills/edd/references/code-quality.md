# Apply code quality checks

Pick the analyzer by language: Rust sources use [rust-code-analysis](#rust-rust-code-analysis); every other language uses [PMD](#other-languages-pmd). In a project with several languages, run each analyzer over its own sources and treat each report separately.

Both analyzers apply the same intent: per-function cyclomatic complexity, cognitive complexity and size limits, plus a ban on inline comments written by agents. The rule files in `assets/` are authoritative; inspect them when interpreting a finding.

## Select sources

Identify every relevant production source directory. Exclude tests and generated sources by selecting appropriate roots. Keep rules in this skill rather than adding configuration to the target project.

## Rust: rust-code-analysis

Prerequisite: `rust-code-analysis-cli` is on PATH, built from a recent upstream commit rather than the 0.0.25 crates.io release, whose grammar rejects async closures, C-string literals and other current syntax:

```sh
cargo install --locked --git https://github.com/mozilla/rust-code-analysis \
  --rev 52ed04e025bce663e787cf2188c80c5a6f0a179c rust-code-analysis-cli
```

The CLI reports `0.0.25` regardless of the commit, so the version line does not prove two runs used the same build. Use the same installation for baseline and final checks. The runner requires Python 3 (`python3`, or `python` on Windows).

Source roots are crate source directories such as `src`, or a crate directory whose `target/` the runner skips. `tests/`, `benches/` and `examples/` are not production roots. The runner also skips items marked `#[cfg(test)]`, `#![cfg(test)]` files, and `#[test]`/`#[<path>::test]` functions.

```sh
python3 /path/to/skill/scripts/check-rust-quality.py \
  /path/to/project crate-a/src crate-b/src
```

The [Rust rules](../assets/rust-quality-rules.json) set report levels for `CyclomaticComplexity`, `CognitiveComplexity` and `LogicalLines`. A function is reported when its value reaches the level. A function's metrics include its closures and nested functions, and methods are named `Type::method`. rust-code-analysis counts every `?` as a branch, so error-propagating code scores higher than the equivalent Java. `LogicalLines` counts statements, the counterpart of PMD's NCSS. `InlineComment` flags every `//` and `/* */` comment that is not a doc comment (`///`, `//!`, `/** */`, `/*! */`). rust-code-analysis has no suppression mechanism.

The runner prints a JSON report to stdout (`files[].violations[]` with `rule`, `function`, `value`, `reportLevel`, `beginLine`, `endLine`, `description`, plus `processingErrors`). The tool version and source count go to stderr. Exit `0` means no findings, `4` means findings, and `2` means the analysis did not complete. A missing tool, no Rust sources, unknown rules, or a file the grammar cannot parse are incomplete checks, never clean results.

## Other languages: PMD

Prerequisite: PMD 7 is available as `pmd` on PATH. Use the same PMD version for baseline and final checks. The shell runner requires Bash and Python 3; the PowerShell runner requires PowerShell 7. The Java ruleset includes skill-owned rules from `assets/pmd-rules/`, which the runners compile with `javac` against PMD's `lib` directory; set `PMD_HOME` to the PMD installation if the runner cannot locate it from `pmd`.

Use the language's ruleset from this skill's `assets/` directory. The bundled [Java ruleset](../assets/java-quality-rules.xml) is the default.

PMD supports multiple languages, but available rules differ. Check [PMD's language support](https://pmd.github.io/pmd/pmd_languages_index.html) and the installed CLI's help before selecting rules. CPD duplication detection does not imply support for PMD rule analysis. If the skill has no suitable ruleset, report the coverage gap to the coordinator; do not apply Java rules to another language or treat unanalyzed code as clean. For multiple PMD languages, run each language's ruleset and matching file pattern separately.

From PowerShell:

```powershell
& /path/to/skill/scripts/check-code-quality.ps1 `
    -ProjectDirectory /path/to/project `
    -SourceDirectory @('src/main/java', 'module/src/main/java')
```

From Bash on Linux or macOS:

```bash
bash /path/to/skill/scripts/check-code-quality.sh \
  /path/to/project src/main/java module/src/main/java
```

For another supported language, supply its skill-owned ruleset and matching source-file pattern. PowerShell accepts `-Ruleset`, `-FilePattern`, and optional `-LanguageVersion` in PMD's `language-version` syntax. Bash uses `PMD_RULESET`, `PMD_FILE_PATTERN`, and optional `PMD_LANGUAGE_VERSION` environment variables. Only Java rules are bundled currently; these options do not supply missing language rules.

Both runners print the JSON report to stdout without saving a report file. PMD version, source count, and diagnostics go to stderr. They call `pmd check` with the selected ruleset, no cache, and suppressed findings included. They do not install tools or modify the project. Exit `0` means no unsuppressed violations, `4` means violations, and `2` means analysis did not complete. Missing tools, empty input, invalid reports, and parsing errors are incomplete checks.

For rules requiring dependency/type resolution, consult the [PMD CLI reference](https://pmd.github.io/pmd/pmd_userdocs_cli_reference.html) and supply the necessary analysis inputs directly to `pmd check`. Preserve stdout reporting, the selected rules, and failure handling.

## Review findings

Capture a baseline before implementation and retain its output in coordinator context. Use the same source scope, rules, language settings, and analyzer build for subsequent checks. Match findings by file, enclosing function/method/class, and rule rather than line number alone; inspect moved code when correspondence is ambiguous.

Resolve newly introduced findings and avoid worsening existing ones. Address pre-existing findings in modified code within feature scope; return scope tradeoffs to the coordinator. Unrelated legacy findings do not require a cleanup campaign. The runners do not subtract the baseline or decide scope.

Production code written by agents carries intent in names, types, and function boundaries; doc comments (Javadoc, Rust `///` and `//!`) are the only comment form agents add. The `InlineComment` rule flags every other line and block comment. Inline comments in the baseline are human-written: leave them untouched, even in modified code. Resolve each new `InlineComment` finding by deleting the comment and moving its intent into the code or the doc comment. A file header the project's build requires (for example, a license header) in a new file is the sole exception; report it rather than removing it.

Inspect the report, including suppressed findings, before declaring success. Confirm that the source inventory and selected rules cover the intended code. Workers must not introduce suppressions or weaken rules to bypass findings. Refactor for meaningful responsibilities and readability, then rerun after the last change. The reviewer runs the same checks independently.
