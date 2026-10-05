import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


CHECKER = Path(__file__).resolve().parents[2] / "scripts/doc-drift/check.py"
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'ops'))
try:
    from git_env import fixture_env
except ModuleNotFoundError:
    def fixture_env():
        env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
        return dict(env, GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull)


class CheckerTest(unittest.TestCase):
    def setUp(self):
        self.env = fixture_env()
        self.root = Path(tempfile.mkdtemp(prefix="doc-drift-fixture-"))
        self.git("init", "-q")
        self.git("config", "core.hooksPath", str(self.root / "fixture-hooks"))
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("config", "user.name", "Fixture")
        self.git("remote", "add", "origin", "https://github.com/jbookout/fixture.git")
        self.git("commit", "--allow-empty", "-qm", "fixture base")

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.root), *args], text=True, env=self.env).strip()

    def write(self, path, text):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
        self.git("add", "--", path)

    def scan(self, *args):
        result = subprocess.run([sys.executable, str(CHECKER), "--root", str(self.root), "--format", "json", *args], text=True, capture_output=True, env=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_reports_missing_path_with_source_line_without_executing_commands(self):
        self.write("README.md", "Run `./bin/gone.sh`.\nSee [guide](docs/gone.md).\n")
        result = self.scan()
        self.assertEqual([(f["file"], f["line"], f["target"]) for f in result["findings"]],
                         [("README.md", 1, "bin/gone.sh"), ("README.md", 2, "docs/gone.md")])
        self.assertEqual(result["owner"], "orchestrator")

    def test_checks_commands_verbs_workflows_jobs_config_and_relative_links(self):
        self.write("run.sh", '#!/bin/sh\ncase "$1" in\nhealth) exit 0 ;;\ncall) exit 0 ;;\nesac\n')
        self.write("mcp-server/src/tools.js", 'import { extraTools } from "./extra.js";\nexport const tools = {"find": {write: true, humanOnly: true, description: "find", handler() {}}};\nregisterTools(extraTools());\n')
        self.write("mcp-server/src/extra.js", 'export const extraTools = () => ({"extra-verb": {description: "extra", handler() {}}});\n')
        self.write("package.json", '{"scripts":{"test":"node --test"}}')
        self.write(".github/workflows/ci.yml", "name: CI\non: pull_request\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps: []\n")
        self.write("config/app.json", '{"ui":{"theme":"dark"}}')
        self.write("docs/guide.md", "# Guide\n")
        self.write("docs/runbook.md", """See [guide](guide.md#guide).
Run `./run.sh health`, `./run.sh call find '{}'`, and `./run.sh call extra-verb '{}'`.
Run `./run.sh vanished` and `./run.sh call gone '{}'`.
Use verb `gone-too` and `npm run lost`.
The workflow `CI` has job `check`.
The workflow `Old CI` has job `old-check`.
Set `ui.theme` in `config/app.json`.
Set config key `ui.removed` in `config/app.json`.
""")
        result = self.scan()
        self.assertEqual({(f["kind"], f["target"]) for f in result["findings"]},
                         {("command", "vanished"), ("verb", "gone"), ("verb", "gone-too"),
                          ("npm-script", "lost"), ("workflow", "Old CI"), ("job", "old-check"),
                          ("config-key", "ui.removed")})

    def test_documents_outside_tree_and_examples_are_explicitly_unchecked(self):
        self.write("README.md", """See [website](https://example.org/guide.md).
Read `~/Library/config.json`, `DNA/old.md`, and `src/<name>.js`.
Example `path/to/file.py`.
""")
        report = self.scan()
        self.assertFalse(report["findings"])
        self.assertGreaterEqual(len(report["unchecked"]), 4)

    def test_deleted_reference_is_selected_when_referenced_file_changes(self):
        self.write("README.md", "Run `bin/task.sh`.\n")
        self.write("bin/task.sh", "echo safe\n")
        self.git("commit", "-qm", "initial fixture")
        base = self.git("rev-parse", "HEAD")
        self.write("bin/task.sh", "echo changed\n")
        self.git("commit", "-qm", "changed target")
        report = self.scan("--base", base)
        self.assertEqual(report["files_checked"], ["README.md"])
        self.write("other.py", "pass\n")
        self.git("commit", "-qm", "unrelated")
        self.assertEqual(self.scan("--base", "HEAD~1")["files_checked"], [])

    def test_rename_suggestion_comes_from_history(self):
        self.write("README.md", "Run `bin/old.sh`.\n")
        self.write("bin/old.sh", "echo safe\n")
        self.git("commit", "-qm", "initial fixture")
        self.git("mv", "bin/old.sh", "bin/new.sh")
        self.git("commit", "-qm", "rename script")
        self.assertEqual(self.scan()["findings"][0]["suggestion"], "bin/new.sh")

    def test_negated_planned_and_generated_references_are_not_stale(self):
        self.write("README.md", """Do not create `GLOSSARY.md`, `docs/adr/`.
This repo has no `run.sh` wrapper.
**Planned:** `node --test test/future.test.mjs`.
Generate `dist/app.js` and `out/report.json`.
Before/after behavior and job/evidence records.
""")
        report = self.scan()
        self.assertFalse(report["findings"])
        self.assertGreaterEqual(len(report["unchecked"]), 5)

    def test_repository_blob_links_are_checked(self):
        self.write("README.md", "[missing](https://github.com/jbookout/fixture/blob/main/docs/gone.md)\n[other](https://github.com/other/project/blob/main/docs/gone.md)\n")
        report = self.scan()
        self.assertEqual([(f["line"], f["target"]) for f in report["findings"]], [(1, "docs/gone.md")])

    def test_fenced_commands_bare_script_names_and_named_workflow_jobs(self):
        self.write("run.sh", 'case "$1" in\nhealth) exit 0 ;;\nesac\n')
        self.write("README.md", "```sh\n./run.sh old\npython3 gone.py\n```\n")
        report = self.scan()
        self.assertEqual({(f["kind"], f["target"]) for f in report["findings"]},
                         {("command", "old"), ("path", "gone.py")})

    def test_directory_claim_selects_doc_when_a_child_changes(self):
        self.write("README.md", "Scripts live in `bin/`.\n")
        self.write("bin/task.sh", "echo safe\n")
        self.git("commit", "-qm", "initial fixture")
        self.write("bin/task.sh", "echo changed\n")
        self.git("commit", "-qm", "changed child")
        self.assertEqual(self.scan("--base", "HEAD~1")["files_checked"], ["README.md"])

    def test_relative_link_cannot_resolve_to_same_named_root_file(self):
        self.write("guide.md", "# Root guide\n")
        self.write("docs/README.md", "[guide](guide.md)\n")
        self.assertEqual([(f["line"], f["target"]) for f in self.scan()["findings"]],
                         [(1, "docs/guide.md")])

    def test_malformed_authority_never_reports_clean(self):
        self.write(".github/workflows/ci.yml", "jobs: [invalid\n")
        result = subprocess.run([sys.executable, str(CHECKER), '--root', str(self.root)], text=True, capture_output=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('no clean verdict', result.stderr)


if __name__ == "__main__":
    unittest.main()
