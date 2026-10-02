# PR delivery cutover

The orchestrator performs this cutover after merge. Node 20.19+, Git with
`merge-tree --write-tree`, `gh`, and `codex` must be on PATH. Authentication
stays in the caller's environment/tool configuration; never put credentials in
JSON. Copy [the example](../config/pr-delivery.example.json) to a private local
config. It is the only repo registry: set each `checkout`, `worktreeRoot`, the
shared `stateDir`, model, effort, limits, and holds (`repo`, `titlePattern`,
`reason`). Paths are absolute or relative to the config, without shell expansion.
Keep config, worktrees, review output, and job/usage/queue records outside Git.
Every invocation must use the same config/state directory for one serial queue.

All cutover steps are required:

1. Set `FACTORY` to the merged factory checkout, `CONFIG` to the private JSON,
   and `OLD` to the existing script directory.
2. Pause old producers and allow active review/fix/merge jobs to finish.
3. Stop the old queue and auto-enqueue consumers; verify no old merge remains active.
4. Run `node "$FACTORY/bin/pr-delivery.mjs" "$CONFIG" import-legacy "$OLD"`.
5. Replace invocations using the table, then start one factory merge queue and one auto-enqueue runner.
6. Watch the first PR through review, queue, squash merge, and verification of its merge commit on main.

The importer reads the old queue/done prefix and budget files without changing
them. It copies pending FIFO entries and recent usage, deduplicates repeat
imports, and refuses unknown/ambiguous repos or inconsistent records. Move old
hold patterns into the JSON before starting producers. Do not run both queues.
The factory does not install a scheduler or take product deployment authority.

Use `R=owner/repository`, `N=<pr>`, `W=<worktree-or-dash>`, `H=<approved-full-sha>`,
`B=<branch>`, `F=<fallback-worktree>`, and `NOTE=<note>` as invocation inputs:

| Old script | Exact factory command |
| --- | --- |
| `pr-loop.sh R N W [rounds]` | `node "$FACTORY/bin/pr-delivery.mjs" "$CONFIG" pr-loop "$R" "$N" "$W" 3` |
| `review-pr.sh R N` | `node "$FACTORY/bin/pr-delivery.mjs" "$CONFIG" review-pr "$R" "$N"` |
| `fix-pr.sh R N W` | `node "$FACTORY/bin/pr-delivery.mjs" "$CONFIG" fix-pr "$R" "$N" "$W"` |
| `ci-fix.sh R N` | `node "$FACTORY/bin/pr-delivery.mjs" "$CONFIG" ci-fix "$R" "$N"` |
| `codex-guard.sh R N kind command...` | `node "$FACTORY/bin/pr-delivery.mjs" "$CONFIG" codex-guard "$R" "$N" "$KIND" "${COMMAND[@]}"` |
| `branch-wt.sh repo-dir B F` | `node "$FACTORY/bin/pr-delivery.mjs" "$CONFIG" branch-wt "$R" "$B" "$F"` |
| `merge-queue.sh` | `node "$FACTORY/bin/pr-delivery.mjs" "$CONFIG" merge-queue` |
| `merge-one-core.sh R N H note` | `node "$FACTORY/bin/pr-delivery.mjs" "$CONFIG" merge-one-core "$R" "$N" "$H" "$NOTE"` |
| `merge-enqueue.sh R N H note` | `node "$FACTORY/bin/pr-delivery.mjs" "$CONFIG" merge-enqueue "$R" "$N" "$H" "$NOTE"` |
| `auto-enqueue.sh` | `node "$FACTORY/bin/pr-delivery.mjs" "$CONFIG" auto-enqueue` |

Set `KIND` and the `COMMAND` argv array for the guard. Replace the loop's `3`
with the existing caller's round limit. `branch-wt` takes the configured repo
identity instead of a checkout path. `ci-fix` re-enters the PR loop; `--no-loop`
disables that for a caller already controlling rounds. Queue/auto-enqueue accept
`--once` for supervised checks. Never use GitHub auto-merge. Direct merge-core
calls acquire the same global merge lease as the queue. Review uses a fresh,
detached worktree and process; builders never post approvals. Queue approval
attestations cannot substitute for independent review comments.

Stops are observable in CLI output; process and adapter outcomes also enter
private `delivery.jsonl`. An unchanged
repair head exits 2 (`NO-PROGRESS`), exhausted usage/slots exits 75, timeout exits
142, unknown repo exits 9. Failed merge outcomes remain in `queue.json`;
transient API errors retry three times after the initial attempt. `usage.json`
shares the rolling 24-hour cap across review, fix, CI-fix, and guard invocations.
Hard timeouts kill the process group. Dirty/diverged branch worktrees are
reported and retained. Prompt restrictions on model actions remain guidance,
with product-repository checks and permissions providing enforcement.

Rollback: pause factory producers, finish active jobs, and stop both factory
consumers. Reconcile pending `queue.json` entries with the old queue, excluding
already merged heads; carry recent `usage.json` runs into the matching old
budget logs before restarting. Restore the previous script invocations and
start exactly one old queue/auto-enqueue pair. Keep factory state for diagnosis;
never reset/rebase/force-push PR branches during rollback. The running source
scripts are unchanged by this PR.
