#!/usr/bin/env python3
"""Reject new TypeScript production files and unreviewed unsafe Rust additions."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
POLICY_PATH = Path(__file__).with_name("migration-rust-only.json")
UNSAFE_CODE = re.compile(
    r"^\s*(?:(?:pub(?:\s*\([^)]*\))?|async|const)\s+)*unsafe\s+"
    r"(?:fn|impl|trait|extern|mod|use)\b|\bunsafe\s*\{"
)


def load_policy(path: Path = POLICY_PATH) -> dict:
    if not path.exists():
        return {"base": "d6f6783", "typescript": {}, "unsafe": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def allowed(path: str, rules: dict[str, str]) -> str | None:
    for prefix, reason in sorted(rules.items(), key=lambda item: len(item[0]), reverse=True):
        if path.startswith(prefix):
            return reason
    return None


def evaluate(
    changed_files: list[str],
    added_rust_lines: dict[str, list[str]],
    policy: dict,
) -> list[str]:
    violations = []
    for path in changed_files:
        if path.endswith((".ts", ".tsx")) and not allowed(path, policy.get("typescript", {})):
            violations.append(f"{path}: new TypeScript implementation is forbidden")
    for path, lines in added_rust_lines.items():
        for line in lines:
            stripped = line.lstrip()
            if stripped.startswith("//"):
                continue
            if UNSAFE_CODE.search(line) and not allowed(path, policy.get("unsafe", {})):
                violations.append(f"{path}: unreviewed unsafe addition: {stripped}")
    return violations


def added_rust_lines(diff: str) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    current = None
    for line in diff.splitlines():
        if line.startswith("+++ b/"):
            current = line[6:]
            result.setdefault(current, [])
        elif line.startswith("+++ "):
            current = None
        elif line.startswith("+") and not line.startswith("+++") and current:
            result[current].append(line[1:])
    return result


def git_diff(base: str, *args: str) -> str:
    return subprocess.run(
        ["git", "diff", *args, base, "--"],
        cwd=REPO_ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    ).stdout


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", help="migration baseline revision")
    args = parser.parse_args()
    policy = load_policy()
    base = args.base or policy.get("base", "d6f6783")
    changed = git_diff(base, "--name-only", "--diff-filter=AM").splitlines()
    violations = evaluate(changed, added_rust_lines(git_diff(base, "--unified=0", "--", "*.rs")), policy)
    if violations:
        for violation in violations:
            print(f"[rust-only] FAIL: {violation}", file=sys.stderr)
        return 1
    print(f"[rust-only] PASS: no forbidden TypeScript or unreviewed unsafe additions since {base}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
