# Instruction drift checker

Run `python3 scripts/doc-drift/ci.py` after installing
`scripts/doc-drift/requirements.txt`. CARR calls the same entry point through
[its CI script](https://github.com/jbookout/carr-system/blob/main/ops/ci.sh)
with the instruction drift option. The checker emits warnings and writes
`out/doc-drift/report.json`; a parser, fixture or Git failure fails the run.

`check.py --root REPOSITORY --base BASE_SHA` selects changed instruction files
and documents referencing changed files, including directories, globs, verb
modules, npm scripts, workflows, jobs and config files. Without a base it scans
all tracked Markdown, MDX and reStructuredText files, including boot files,
skills, READMEs and runbooks. It never executes documented commands.

Concrete syntax includes local paths and Markdown links, inline filenames,
shell script invocations, CARR wrapper commands and verb calls, npm script
invocations, and workflow and job names in inline code. Config references may
append a hash and dotted key to the filename. A named key on the same line as a JSON, YAML or
TOML file is checked against that file. Verbs resolve from tools.js and its
local imports. Main-branch GitHub blob links to this repository resolve locally.

Each claim carries its file, line, kind, target and source dependencies.
Missing claims include rename evidence from Git and `git log --follow` when
available; similarity suggestions are explicitly unverified. External and
machine-local references, parameterized examples, generated outputs, negated
existence statements and planned references are listed as unchecked. The
checker cannot prove arbitrary prose behavior, dynamic shell dispatch or
configuration loaded from outside the tree. A clean report covers extracted,
checkable claims only.

On PRs, warnings and a JSON artifact go to the orchestrator. The weekly main
run reconciles GitHub issue loops through `loops.py`: one stable marker per
repository and stale file, with all findings grouped into its issue body.
The issue names the orchestrator, repair command and clearance test. Full clean
scans close loops; recurring drift reopens the same issue. PR jobs hold read
permission; only the main-only weekly job holds issue-write permission. No
partner is mentioned or assigned. This is a development loop, not a production
CARR record mutation.

`loops.py --report REPORT --repo OWNER/REPOSITORY` previews changes read-only.
`--apply` reconciles them. It reads all issue pages, refuses duplicate markers,
and reports failures without printing authentication or API error bodies.
After an interrupted write, read issues again before retrying.

The factory owns the implementation. Products retain local snapshots and
fixtures with a source revision and file hashes, so their CI does not depend on
a running factory. Update a snapshot through a source PR and run its fixtures.
The weekly workflow starts only after this source reaches main. Its first
hosted run must be checked by the orchestrator.
