#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "check-migration-rust-only.py"
SPEC = importlib.util.spec_from_file_location("check_migration_rust_only", SCRIPT)
assert SPEC and SPEC.loader
mod = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = mod
SPEC.loader.exec_module(mod)


class MigrationRustOnlyTest(unittest.TestCase):
    def test_rejects_production_typescript(self) -> None:
        violations = mod.evaluate(["crates/browser/driver.ts"], {}, {})
        self.assertEqual(len(violations), 1)
        self.assertIn("TypeScript", violations[0])

    def test_allows_only_registered_fixture_prefix(self) -> None:
        policy = {"typescript": {"crates/codegraph/tests/fixtures/": "parser inputs"}}
        self.assertEqual(mod.evaluate(["crates/codegraph/tests/fixtures/basic.ts"], {}, policy), [])
        self.assertEqual(len(mod.evaluate(["crates/codegraph/src/basic.ts"], {}, policy)), 1)

    def test_rejects_unsafe_blocks_functions_and_impls(self) -> None:
        lines = {"crates/demo/src/lib.rs": ["unsafe { ptr.read() }", "pub unsafe fn read() {}", "unsafe impl Send for Driver {}"]}
        violations = mod.evaluate([], lines, {})
        self.assertEqual(len(violations), 3)

    def test_lint_attributes_and_comments_are_not_unsafe_code(self) -> None:
        lines = {"crates/demo/src/lib.rs": ["#![forbid(unsafe_code)]", "#[allow(unsafe_code)]", "// unsafe { example }"]}
        self.assertEqual(mod.evaluate([], lines, {}), [])

    def test_unsafe_requires_matching_registration(self) -> None:
        policy = {"unsafe": {"crates/codegraph/src/ffi/": "tree-sitter C ABI"}}
        accepted = {"crates/codegraph/src/ffi/parser.rs": ["unsafe extern \"C\" fn parse() {}"]}
        rejected = {"crates/codegraph/src/query.rs": ["unsafe { ptr.read() }"]}
        self.assertEqual(mod.evaluate([], accepted, policy), [])
        self.assertEqual(len(mod.evaluate([], rejected, policy)), 1)

    def test_diff_parser_only_returns_added_rust_lines(self) -> None:
        diff = "+++ b/crates/demo/src/lib.rs\n+fn added() {}\n-fn old() {}\n+++ /dev/null\n"
        self.assertEqual(mod.added_rust_lines(diff), {"crates/demo/src/lib.rs": ["fn added() {}"]})

    def test_git_diff_places_options_before_revision(self) -> None:
        with patch.object(mod.subprocess, "run") as run:
            run.return_value.stdout = ""
            mod.git_diff("abc123", "--name-only", "--diff-filter=AM")
        command = run.call_args.args[0]
        self.assertEqual(command, ["git", "diff", "--name-only", "--diff-filter=AM", "abc123", "--"])


if __name__ == "__main__":
    unittest.main()
