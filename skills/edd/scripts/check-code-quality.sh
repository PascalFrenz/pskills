#!/usr/bin/env bash
# PMD must already be on PATH. Reports remain in temporary storage.
set -euo pipefail
trap 'exit 2' ERR
fail() { printf '%s\n' "$*" >&2; exit 2; }
[[ $# -ge 2 ]] || fail 'Usage: check-code-quality.sh PROJECT SOURCE_DIRECTORY [SOURCE_DIRECTORY ...]'
command -v pmd >/dev/null || fail 'PMD CLI is not on PATH.'
command -v python3 >/dev/null || fail 'Python 3 is required.'
version=$(pmd --version 2>&1) || fail 'Cannot run PMD.'
[[ "$version" == *'PMD 7.'* ]] || fail "PMD 7 is required. Found: $version"
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
rules=${PMD_RULESET:-$script_dir/../assets/java-quality-rules.xml}
pattern=${PMD_FILE_PATTERN:-'*.java'}
[[ -f "$rules" ]] || fail "Ruleset not found: $rules"
output=$(mktemp -d "${TMPDIR:-/tmp}/edd-pmd.XXXXXXXX")
file_list=$output/sources.txt
report=$output/report.json
python3 - "$file_list" "$pattern" "$@" <<'PY'
import fnmatch
import os
import pathlib
import sys

destination, pattern, project, *roots = sys.argv[1:]
project = pathlib.Path(project).resolve(strict=True)
if not project.is_dir():
    raise SystemExit('Project is not a directory')
files = set()
def onerror(error):
    raise error
for root in roots:
    source = (project / root).resolve(strict=True)
    if not source.is_dir():
        raise SystemExit(f'Not a source directory: {source}')
    for directory, _, names in os.walk(source, onerror=onerror):
        for name in names:
            if fnmatch.fnmatchcase(name, pattern):
                path = str(pathlib.Path(directory) / name)
                if any(c in path for c in '\r\n,'):
                    raise SystemExit('PMD file lists cannot safely represent commas or newlines in paths')
                files.add(path)
if not files:
    raise SystemExit('No matching source files found')
pathlib.Path(destination).write_text('\n'.join(sorted(files)) + '\n', encoding='utf-8')
print(f'Sources: {len(files)}')
PY
args=(check --file-list "$file_list" --rulesets "$rules" --format json
    --report-file "$report" --no-cache --no-progress --show-suppressed
    --fail-on-error --fail-on-violation)
if [[ -n ${PMD_LANGUAGE_VERSION:-} ]]; then
    args+=(--use-version "$PMD_LANGUAGE_VERSION")
fi
printf 'PMD: %s\nReport: %s\n' "$version" "$report"
result=0
pmd "${args[@]}" || result=$?
[[ $result == 0 || $result == 4 ]] || fail "PMD analysis failed (exit $result). Report, if available: $report"
python3 - "$report" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
if not isinstance(data, dict) or not isinstance(data.get('files'), list):
    raise SystemExit('Invalid PMD report')
if data.get('processingErrors') or data.get('configurationErrors'):
    raise SystemExit('PMD report contains analysis errors')
PY
printf 'Review suppressed violations as well as ordinary findings in %s\n' "$report"
exit "$result"
