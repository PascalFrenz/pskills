#!/usr/bin/env python3
"""Check Rust production code against the skill's quality rules.

rust-code-analysis-cli must already be on PATH. The JSON report goes to stdout;
the tool version, source count, and diagnostics go to stderr. Exit 0 means no
findings, 4 means findings, 2 means the analysis did not complete.
"""
import argparse
import concurrent.futures
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys

CLI = "rust-code-analysis-cli"
KNOWN_RULES = {"CyclomaticComplexity", "CognitiveComplexity", "LogicalLines", "InlineComment"}
METRICS = {
    "CyclomaticComplexity": ("cyclomatic complexity", lambda metrics: metrics["cyclomatic"]["sum"]),
    "CognitiveComplexity": ("cognitive complexity", lambda metrics: metrics["cognitive"]["sum"]),
    "LogicalLines": ("logical lines", lambda metrics: metrics["loc"]["lloc"]),
}
ANSI = re.compile(r"\x1b\[[0-9;]*m")
NODE = re.compile(r"\{(.*?):\d+\} from \((\d+), (\d+)\) to \((\d+), (\d+)\)")
TEST_ATTRIBUTE = re.compile(r"#\[(cfg\(test\)|test|(\w+::)+test(\(.*\))?)\]", re.S)
INNER_TEST_ATTRIBUTE = re.compile(r"#!\[cfg\(test\)\]")
TRANSPARENT_KINDS = {"attribute_item", "line_comment", "block_comment"}
CONTAINER_KINDS = {"impl", "trait"}


class AnalysisError(Exception):
    pass


def fail(message):
    print(message, file=sys.stderr)
    sys.exit(2)


def run_cli(cli, *arguments):
    result = subprocess.run([cli, *arguments], capture_output=True)
    stdout = result.stdout.decode("utf-8", "replace")
    stderr = result.stderr.decode("utf-8", "replace").strip()
    if result.returncode != 0 or stderr:
        raise AnalysisError(f"{CLI} {' '.join(arguments[:-1])} failed (exit {result.returncode}): {stderr}")
    return stdout


def load_rules(path):
    try:
        rules = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        fail(f"Cannot read rules {path}: {error}")
    if not isinstance(rules, dict) or not rules:
        fail(f"Rules must be a non-empty JSON object: {path}")
    for name, settings in rules.items():
        if name not in KNOWN_RULES:
            fail(f"Unknown rule {name} in {path}")
        if name in METRICS and not isinstance((settings or {}).get("reportLevel"), (int, float)):
            fail(f"Rule {name} needs a numeric reportLevel in {path}")
    return rules


def find_sources(project, roots):
    project = pathlib.Path(project).resolve(strict=True)
    if not project.is_dir():
        fail(f"Project is not a directory: {project}")
    files = set()
    for root in roots:
        source = (project / root).resolve()
        if not source.is_dir():
            fail(f"Not a source directory: {source}")
        for directory, subdirectories, names in os.walk(source):
            subdirectories[:] = [name for name in subdirectories if name != "target"]
            files.update(pathlib.Path(directory) / name for name in names if name.endswith(".rs"))
    if not files:
        fail("No Rust source files found. Check the source directories.")
    return sorted(files)


def parse_dump(dump):
    nodes = []
    for line in ANSI.sub("", dump).splitlines():
        match = NODE.search(line)
        if match:
            kind, *span = match.groups()
            nodes.append((match.start() // 3, kind, *map(int, span)))
    if not nodes:
        raise AnalysisError("AST dump is empty")
    return nodes


def node_text(lines, start_line, start_column, end_line, end_column):
    if start_line == end_line:
        return lines[start_line - 1][start_column - 1:end_column - 1].decode("utf-8", "replace")
    parts = [lines[start_line - 1][start_column - 1:], *lines[start_line:end_line - 1], lines[end_line - 1][:end_column - 1]]
    return b"\n".join(parts).decode("utf-8", "replace")


def is_doc_comment(text):
    return (text.startswith(("///", "//!")) and not text.startswith("////")) or (
        text.startswith(("/**", "/*!")) and not text.startswith(("/***", "/**/")))


def test_ranges(nodes, lines):
    ranges = []
    pending = {}
    for depth, kind, start_line, start_column, end_line, end_column in nodes:
        for deeper in [key for key in pending if key > depth]:
            del pending[deeper]
        if kind == "inner_attribute_item" and depth == 1:
            if INNER_TEST_ATTRIBUTE.fullmatch(re.sub(r"\s", "", node_text(lines, start_line, start_column, end_line, end_column))):
                ranges.append((1, len(lines) + 1))
        elif kind == "attribute_item":
            text = re.sub(r"\s", "", node_text(lines, start_line, start_column, end_line, end_column))
            pending[depth] = pending.get(depth, False) or bool(TEST_ATTRIBUTE.fullmatch(text))
        elif kind not in TRANSPARENT_KINDS and depth in pending:
            if pending.pop(depth):
                ranges.append((start_line, end_line))
    return ranges


def functions(space, scope=()):
    for child in space.get("spaces", []):
        if child["kind"] == "function":
            yield "::".join((*scope, child["name"])), child
        else:
            yield from functions(child, (*scope, child["name"]) if child["kind"] in CONTAINER_KINDS else scope)


def analyze(cli, path, rules):
    lines = path.read_bytes().splitlines()
    nodes = parse_dump(run_cli(cli, "-d", "-p", str(path)))
    errors = [node for node in nodes if node[1] == "ERROR"]
    if errors:
        raise AnalysisError(f"Parse error at line {errors[0][2]}")
    excluded = test_ranges(nodes, lines)
    in_tests = lambda line: any(start <= line <= end for start, end in excluded)
    violations = []
    if "InlineComment" in rules:
        for _, kind, start_line, start_column, end_line, end_column in nodes:
            if kind in ("line_comment", "block_comment") and not in_tests(start_line):
                text = node_text(lines, start_line, start_column, end_line, end_column)
                if not is_doc_comment(text):
                    violations.append({
                        "rule": "InlineComment", "beginLine": start_line, "endLine": end_line,
                        "description": "Express this intent in names, types, or structure instead of an inline comment",
                    })
    try:
        space = json.loads(run_cli(cli, "-m", "-O", "json", "-p", str(path)))
    except ValueError as error:
        raise AnalysisError(f"Invalid metrics output: {error}") from error
    for name, function in functions(space):
        if in_tests(function["start_line"]):
            continue
        for rule, (label, measure) in METRICS.items():
            if rule not in rules:
                continue
            try:
                value = measure(function["metrics"])
            except (KeyError, TypeError) as error:
                raise AnalysisError(f"Missing {label} for {name}") from error
            level = rules[rule]["reportLevel"]
            if value >= level:
                violations.append({
                    "rule": rule, "function": name, "value": value, "reportLevel": level,
                    "beginLine": function["start_line"], "endLine": function["end_line"],
                    "description": f"{name} has {label} {value:g}, report level {level:g}",
                })
    return sorted(violations, key=lambda violation: (violation["beginLine"], violation["rule"]))


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--rules", default=pathlib.Path(__file__).resolve().parent.parent / "assets" / "rust-quality-rules.json")
    parser.add_argument("project")
    parser.add_argument("source_directories", nargs="+")
    arguments = parser.parse_args()
    cli = shutil.which(CLI)
    if not cli:
        fail(f"{CLI} is not on PATH. Install it with: cargo install {CLI}")
    try:
        version = subprocess.run([cli, "--version"], capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as error:
        fail(f"Cannot run {CLI}: {error}")
    rules = load_rules(arguments.rules)
    sources = find_sources(arguments.project, arguments.source_directories)
    print(f"Tool: {version}", file=sys.stderr)
    print(f"Sources: {len(sources)}", file=sys.stderr)
    report = {"tool": version, "rules": rules, "files": [], "processingErrors": []}
    with concurrent.futures.ThreadPoolExecutor() as pool:
        futures = {path: pool.submit(analyze, cli, path, rules) for path in sources}
        for path, future in futures.items():
            try:
                violations = future.result()
            except (AnalysisError, OSError) as error:
                report["processingErrors"].append({"filename": str(path), "message": str(error)})
                continue
            if violations:
                report["files"].append({"filename": str(path), "violations": violations})
    print(json.dumps(report, indent=2))
    if report["processingErrors"]:
        fail("Analysis did not complete; see processingErrors.")
    sys.exit(4 if report["files"] else 0)


if __name__ == "__main__":
    main()
