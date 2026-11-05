# Apply code quality checks

Prerequisite: PMD 7 is available as `pmd` on PATH. Use the same PMD version for baseline and final checks. The shell runner requires Bash and Python 3; the PowerShell runner requires PowerShell 7.

## Select rules and sources

Use the language's ruleset from this skill's `assets/` directory. The bundled [Java ruleset](../assets/java-quality-rules.xml) is the default. The XML is authoritative; inspect it when interpreting a finding.

PMD supports multiple languages, but available rules differ. Check [PMD's language support](https://pmd.github.io/pmd/pmd_languages_index.html) and the installed CLI's help before selecting rules. CPD duplication detection does not imply support for PMD rule analysis. If the skill has no suitable ruleset, report the coverage gap to the coordinator; do not apply Java rules to another language or treat unanalyzed code as clean.

Identify every relevant production source directory. Exclude tests and generated sources by selecting appropriate roots. For multiple languages, run each language's ruleset and matching file pattern separately. Keep rules in this skill rather than adding configuration to the target project.

## Run PMD

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

Both runners print a source count and JSON report path in temporary storage. They call `pmd check` with the selected ruleset, no cache, and suppressed findings included. They do not install tools or modify the project. Exit `0` means no unsuppressed violations, `4` means violations, and `2` means analysis did not complete. Missing tools, empty input, invalid reports, and parsing errors are incomplete checks.

## Review findings

Capture a baseline before implementation and retain its report path in coordinator context. Use the same source scope, ruleset, language settings, and PMD version for subsequent checks. Match findings by file, enclosing method/class, and rule rather than line number alone; inspect moved code when correspondence is ambiguous.

Resolve newly introduced findings and avoid worsening existing ones. Address pre-existing findings in modified code within feature scope; return scope tradeoffs to the coordinator. Unrelated legacy findings do not require a cleanup campaign. The runners do not subtract the baseline or decide scope.

Inspect the report, including suppressed findings, before declaring success. Confirm that the source inventory and selected rules cover the intended code. Workers must not introduce suppressions or weaken rules to bypass findings. Refactor for meaningful responsibilities and readability, then rerun after the last change. The reviewer runs the same checks independently.

For rules requiring dependency/type resolution, consult the [PMD CLI reference](https://pmd.github.io/pmd/pmd_userdocs_cli_reference.html) and supply the necessary analysis inputs directly to `pmd check`. Keep reports outside the project and preserve the selected rules and failure handling.
