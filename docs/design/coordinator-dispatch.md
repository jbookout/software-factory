Size S. One command and four templates, one PR. No subagents by explicit brief.
Data shape: JSON request {card: dispatch-job arguments including UUID idempotency_key, template: enum, variables: string map}. Card fields stay under CARR validation authority.
Grounding: run.sh call emits a JSON success envelope; dispatch-job mints an idempotent queued card, starts no runner. T3 delegate_task accepts task text and isolation but no CARR mint/template fields. gh alias composes gh commands, not CARR writes. Existing skills/dispatch is prose plus native launch commands, no mint/render command.
Two interfaces considered: many flags per card field versus one JSON request file. Choose file input plus explicit path overrides; it preserves CARR's evolving schema and avoids shell interpolation. Python standard library only.
Throughput checkpoint:
- Blocking first steps. Live contracts, platform-first inspection and overlap check before code.
- Independent workstreams. n/a, single worker owns coupled command and tests.
- Shared mutable state. Per-card filenames; atomic replace and identical retry content; per-request file lock prevents conflicting local retries.
- Smallest safe decomposition. One worker; CLI tests exercise actual subprocess with synthetic run.sh, no production writes.
System design: CLI owns rendering and two brief files; CARR owns card identity/idempotency; coordinator owns T3 delegation. Template preflight occurs before one bounded 30-second external call. Fail closed, no automatic retries/fallback; nonzero exit is alert to caller. Caller reuses UUID after timeout. At most one mint call per invocation is the rate cap. No queues, network fan-out, credential storage, DB access, or cache. Files keyed by card id are tiny at current and 10x dispatch load; local disk and CARR latency break first. Same-request concurrent calls serialize with flock. Local receipt rejects changed request for the same UUID and caches the successful card response. Existing files must agree; retry repairs a missing copy. No stale success. Partial local writes recover on retry with same key.
Statechart:
```mermaid
stateDiagram-v2
  [*] --> Validating
  Validating --> Failed: invalid request or template
  Validating --> Minting: preflight passed
  Minting --> Failed: refusal, timeout, malformed response
  Minting --> Publishing: registered card returned
  Publishing --> Failed: local conflict or disk failure
  Publishing --> Ready: both copies match
  Ready --> Ready: identical retry
```
Claim to measure: synthetic coordinator-facing preparation exchange bytes decrease with one command; not tokens, elapsed-time speed or quota prediction. Compare semantically identical mint and brief preparation, exclude unchanged delegate call. Verify generated copies and call count during measurement.

## Command reference

Run `python3 bin/coordinator-dispatch.py request.json`. A request has exactly
`card`, `template`, and `variables`. The card is the deployed `dispatch-job`
input with a caller-chosen UUID. Reuse it for the same intended job. A synthetic
complete request is in `tests/fixtures/dispatch/request.json`.

Templates are `build`, `review`, `fix`, and `open-held-branch` in
`bin/dispatch-templates/`. All use `goal`, `acceptance`, `production_proof`, and
`skills`. Review also uses `pr_url` and `head_sha`; fix uses `pr_url` and
`findings`; open-held-branch uses `branch`. Values are literal text.
`card_id` and the Card marker are reserved. The command supplies repository,
poteto-mode and standing-preferences paths. The paths derive from the current
home directory; specialist skills remain the coordinator's choice.

Defaults use `~/carr-system/run.sh call dispatch-job`, `/tmp`, and
`~/.claude/orchestrate/doctorcre-delivery/briefs`. `--carr-root`, `--tmp-dir`,
and `--brief-dir` override those roots for isolated tests. `--timeout` is a
positive call deadline up to 30 seconds. No credential is read by this wrapper.
CARR's runner owns authentication and authoritative card-field validation.

Success prints exactly `WRn.Sn.Jn /tmp/brief-WRn.Sn.Jn.md` and a newline.
Failure prints a diagnostic on stderr, exits nonzero, and prints no success.
The coordinator reads the brief and calls T3 `delegate_task` itself, retaining
its chosen provider, model, runtime options and worktree isolation. The wrapper
never starts a worker, arms a merge, or changes settings or hooks.

The brief archive owns a `.requests/<uuid>.json` receipt with the exact request,
rendering inputs and successful CARR response. A nonblocking OS lock rejects
concurrent reuse. A changed request or template under the same UUID refuses.
A successful mint is saved before publishing. An identical retry reuses that
response and repairs a missing copy without a new CARR call. Existing different
brief content refuses. Each copy publishes atomically without overwriting.
The two copies are sequential, so a disk failure can leave one copy; only two
verified copies produce the success line. Do not delete receipts to retry.
A corrupt receipt refuses rather than guessing. An interrupted call with no
saved response must be reconciled using the same UUID within CARR's replay
window; this wrapper cannot make that remote transaction atomic with local IO.
No retry is automatic.

## Platform-first evidence

Inspected this session: T3 `delegate_task` and `orchestrator_capabilities` tool
schemas, `gh help alias`, repository `skills/dispatch/SKILL.md`, `tools/`, and
`lib/`, and deployed CARR `list-verbs` filtered to `dispatch-job`.
T3 accepts task text and execution settings; its inspected schema has no CARR
card mint or local template operation. GitHub aliases compose GitHub CLI calls.
The dispatch skill describes launch instructions. This command fills only the
CARR mint and local brief preparation gap. It does not replace delegation.

## Verification and measurement

`node --test tests/coordinator-dispatch.test.mjs` runs the CLI and validates the
synthetic card request against the captured deployed input schema. The response
fixture is source-contract checked, uses synthetic identifiers, and passes the
production response parser. Its source revision is recorded beside it.

`python3 bin/measure-dispatch.py` executes five synthetic preparations and
checks one mint plus identical brief copies each time. The baseline serializes
the mint command and response plus the full brief write and copy operation.
The new exchange serializes the complete request-file contents, command and
one-line response. It counts compact JSON UTF-8 bytes, including shell argument
encoding. The unchanged T3 delegation, model envelopes, hooks, and internal
server traffic are excluded. The five runs measured 1,710 bytes before and
1,102 after, with zero errors. The ranges were identical to those values. Paths
contribute to these counts, so other checkout path lengths change the numbers.
This is a deterministic payload count, not a timing benchmark, measured token
usage or a prediction of subscription savings. No production mint was executed.

## Statechart transition coverage

- Invalid request/template to Failed: `test_preflight_refuses_before_mint`.
- Validating to Minting to Publishing to Ready: `test_mints_and_publishes_one_line`, `test_all_templates`.
- Minting to Failed: `test_refusal_and_malformed_success_do_not_publish`, `test_timeout_does_not_publish_or_retry`.
- Publishing to Failed: `test_file_conflict_refuses_without_success`, `test_partial_publish_repairs_on_same_key_retry`.
- Retry to Ready without minting: `test_retry_repairs_missing_copy_and_rejects_changed_request`, `test_partial_publish_repairs_on_same_key_retry`.
- Concurrent request to Failed: `test_concurrent_same_request_refuses_without_second_mint`.
- Literal template values: `test_literal_variables_are_not_executed_or_expanded`.

## Design and debt pass

Codebase-design compared flags with one structured request. One command hides
minting, rendering, response validation, publication and retry recovery. The
subprocess is the test seam; CARR keeps card schema and identity authority.
Zero-tech-debt kept one implementation and shared common brief text. There is
no new delegation, queue, credential store, or compatibility interface. These
new files replace repeated coordinator mint/write/copy calls; existing caller
migration belongs to the coordinator's adoption after merge.
