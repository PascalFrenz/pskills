#!/usr/bin/env bash
# PMD must already be on PATH.
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
print(f'Sources: {len(files)}', file=sys.stderr)
PY
if grep -q 'class="edd\.pmd\.' "$rules"; then
    command -v javac >/dev/null || fail 'javac is required to compile the skill-owned PMD rules.'
    pmd_home=${PMD_HOME:-$(python3 -c 'import os, sys; print(os.path.dirname(os.path.dirname(os.path.realpath(sys.argv[1]))))' "$(command -v pmd)")}
    compgen -G "$pmd_home/lib/pmd-java-*.jar" >/dev/null || fail "Cannot find PMD's lib directory under $pmd_home; set PMD_HOME to the PMD installation."
    classes=$output/rules
    javac -Xlint:-options -source 8 -target 8 -cp "$pmd_home/lib/*" -d "$classes" "$script_dir"/../assets/pmd-rules/*.java >&2 \
        || fail 'Cannot compile the skill-owned PMD rules.'
    export CLASSPATH=$classes${CLASSPATH:+:$CLASSPATH}
fi
args=(check --file-list "$file_list" --rulesets "$rules" --format json
    --no-cache --no-progress --show-suppressed
    --fail-on-error --fail-on-violation)
if [[ -n ${PMD_LANGUAGE_VERSION:-} ]]; then
    args+=(--use-version "$PMD_LANGUAGE_VERSION")
fi
printf 'PMD: %s\n' "$version" >&2
result=0
report=$(pmd "${args[@]}") || result=$?
printf '%s\n' "$report"
[[ $result == 0 || $result == 4 ]] || fail "PMD analysis failed (exit $result)."
python3 -c '
import json
import sys

data = json.load(sys.stdin)
if not isinstance(data, dict) or not isinstance(data.get("files"), list):
    raise SystemExit("Invalid PMD report")
if data.get("processingErrors") or data.get("configurationErrors"):
    raise SystemExit("PMD report contains analysis errors")
' <<< "$report"
exit "$result"
