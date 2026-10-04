# PR delivery cutover

The orchestrator performs this cutover after merge. Node 20.19+, Git with
`merge-tree --write-tree`, `gh`, and `codex` must be on PATH. Authentication
stays in the caller's environment/tool configuration; never put credentials in
JSON. Copy [the example](../config/pr-delivery.example.json) to a private local
config. It is the only repo registry: set each `checkout`, `worktreeRoot`, the
shared `stateDir`, model, effort, limits, and holds (`repo`, `titlePattern`,
`reason`). Each repository must also name its `requiredChecks` as
`[{ "name": "context", "appId": 15368 }]`; `appId` is optional where the
product's policy does not bind a producer. An empty inventory refuses admission.
Read the product's current branch rules via REST at rollout; the example's
`test` context is not a universal inventory. Paths are absolute or relative to
the config, without shell expansion.
The checkout's origin must identify its configured GitHub repository. A private
`originUrl` can pin an exact alternate remote URL. Repairs support same-repository
PRs targeting `main`; forks and other base branches stop before work starts.
Keep config, worktrees, review output, and job/usage/queue records outside Git.
Every invocation must use the same config/state directory for one serial queue.

All cutover steps are required:

1. Set `FACTORY` to the merged factory checkout, `CONFIG` to the private JSON,
   and `OLD` to the existing script directory.
2. Pause old producers and allow active review/fix/merge jobs to finish.
3. Stop the old queue and auto-enqueue consumers; verify no old merge remains active.
4. Run `node "$FACTORY/bin/pr-delivery.mjs" "$CONFIG" import-legacy "$OLD"`.
5. Install the factory entry points described below, then start one factory merge queue and one auto-enqueue runner.
6. Watch the first PR through review, queue, squash merge, and verification of its merge commit on main.

The importer reads the old queue/done prefix and budget files without changing
them. It copies pending FIFO entries and recent usage, deduplicates repeat
imports, and refuses unknown/ambiguous repos or inconsistent records.
The source directory, `merge-queue.txt`, `merge-queue.done`, and `budget/` must
exist and be readable. Empty files and an empty budget directory represent an
empty source; missing inputs fail before destination queue or usage writes.
Imported review comments never authorize delivery. Run a fresh factory review
for imported pending work so the private review evidence exists before merging.
Move old hold patterns into the JSON before starting producers. Do not run both queues.
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
attestations cannot substitute for independent review comments. Each review uses
a unique attempt directory; live, dirty, or interrupted attempts are preserved.
Accepted approvals carry a `Factory-Review` reference to private execution,
source tree, prompt, and exact reviewer output records. Keep these records in
the shared state directory. A matching GitHub author name alone proves nothing.
Queue comments say `DELIVERY VERIFIED` and are outside the review protocol.

Stops are observable in CLI output; process and adapter outcomes also enter
private `delivery.jsonl`. An unchanged
repair head exits 2 (`NO-PROGRESS`), exhausted usage/slots exits 75, timeout exits
142, unknown repo exits 9. Failed merge outcomes remain in `queue.json`;
transient API errors retry three times after the initial attempt.
Automatic scanning can enqueue a recovered failed head again, preserving prior
outcomes and linking attempts. `queueRunsPer24h` bounds automatic queue entries
for a head in a rolling day; active and successful entries stay deduplicated.
Scans paginate REST results until completeness is observed, with a visible stop
at the repository bound instead of silent tail truncation. REST pages contain
at most 25 objects with a 16 MB capture allowance for long bodies and check
output; the scan retains its 10,000-row bound. The canonical
required-check policy and provider retry rules are described below. Closed PRs
do no agent work; merged PRs must
prove the squash commit, target ancestry, and delivered source tree again.
`usage.json` shares the rolling 24-hour cap across review, fix, CI-fix, and guard invocations.
An independent process supervisor owns each job's deadline and child group.
Slot and PR ownership records bind that supervisor, group, and deadline; caller
termination stops the group before another job can use its ownership. Unique
ticket records replace directory reapers, so dead owners recover without a
permanent reaper lock. Run one factory version against a state directory.
Hard timeouts kill the process group. Dirty/diverged/ahead branch worktrees are
reported and retained. Prompt restrictions on model actions remain guidance,
with product-repository checks and permissions providing enforcement.

Rollback: pause factory producers, finish active jobs, and stop both factory
consumers. Reconcile pending `queue.json` entries with the old queue, excluding
already merged heads; carry recent `usage.json` runs into the matching old
budget logs before restarting. Restore the previous script invocations and
start exactly one old queue/auto-enqueue pair. Keep factory state for diagnosis;
never reset/rebase/force-push PR branches during rollback. The running source
scripts are unchanged by this PR.

## Budget and CI deployment entry points

The maintained adapters are in `deploy/orch/`. They execute the same CLI used by
the replay tests; they contain no budget, review or CI policy of their own.
After draining active workers, copy **all** of that directory's `.sh` files to
the private orchestration script directory. Set `FACTORY_ROOT` to the merged,
pinned factory checkout and `FACTORY_PR_CONFIG` to the shared private config
in every worker and scheduler environment. Keep the prior scripts for rollback.
The factory does not edit or install into the running script directory itself.

`unstick.sh` and `stall-watch.sh` are **PR recovery entry points**: both reconcile
the same private wait records through `recover`, with `--once` for supervision.
They no longer use independent cooldown ledgers or tail-log heuristics. They
resume only recorded factory waits; retain the legacy watcher's unrelated Dot
report/feeder monitoring in its existing separate supervisory lane before
replacing its PR-recovery invocation. This cutover also changes model execution
to the configured factory lane; the legacy Flash/Opus/host-overflow and CPU
governor routines are not ported by these two fixes. The orchestrator must keep
resource admission at the supervising worker/host and choose the lane before
cutover. Never run legacy PR recovery writers alongside the factory adapters.

The shared wait record binds repository, PR, full head, typed cause, declared
dependency revision, exit code and reset time. Repeated refusals leave one wait
event; they do not consume reservations or launch children. `dependencyRevision`
is an optional product-owned pin for a newly tested actionable dependency, not
a timer or a generic retry token. No-progress/round-limit waits need a changed
head or that pin. Budget waits reopen at their recorded rolling-window reset or
when the current usage/config proves capacity reopened; reservation rechecks
the budget atomically. A child exit 75 without known reset guidance waits for
changed input. Slot ownership and child cleanup retain the factory supervisor.
Slot-wait refusals retry atomic reservation on the next invocation, so released
slots restore admission without changing source or consuming extra budget.
Every repair entry point records unchanged-head no-progress through the repair
operation itself. Recovery batches retain the first nonzero exit code even
when a later candidate succeeds.
Successful delivery-loop completion retires recovery eligibility while keeping
the prior wait record. Closing a PR refuses work; reopening without changed
eligibility retains its stop. Queue outcomes and original CI evidence survive.

`readiness R N [H]` exposes the canonical observation: `success`, `pending`,
`failure`, `provider-unknown` or `superseded`. Required contexts must succeed on
the exact current head; skipped/neutral required jobs, cancellation and absent
contexts never authorize enqueue or merge. Optional skipped/neutral jobs remain
accepted. Obsolete heads request observation of the current head and start no
fixer. Current cancellation requests a check rerun; authenticated assertion
failure remains repairable. All new provider reads use paginated REST checks,
commit statuses, PRs and comments. Malformed/permission responses stop.
CheckRun status and conclusion are validated separately: an unfinished run
must have no conclusion, and only completed success can satisfy a required run.
Transport timeout, quota-evidenced 403, 429 and temporary 5xx reads retry at most
twice, respecting bounded provider delay. They never become CI-red.

`usage.json` counts reservations, `delivery.jsonl` records dispatched child
starts separately, and wait events name their cause/reset. Neither count proves
paid model usage. The audit's weekly reduction targets require matched rollout
cohorts; these replays do not establish fleet savings or active installation.

## Deadline and child-capacity cutover

Configure `queueTimeoutMs`, `apiTimeoutMs`, and `attemptTimeoutMs` separately
from `checksTimeoutMs`, `commandTimeoutMs`, and `limits.timeoutMs`. The attempt
clock spans nested delivery steps and rounds in one exclusive invocation.
Phase budgets, individual commands, provider pacing, and cleanup share that
remaining monotonic budget. Readiness checks run immediately, then back off;
Retry-After/reset guidance never renews the API or attempt deadline. The ledger
records API, readiness, queue, execution, and cleanup durations and typed stops.
The supervisor reserves termination time inside the process deadline, including
an unresponsive launch binding. Active process expiry uses the shared host
monotonic clock; persisted wall deadlines are readback metadata. Lease recovery
does not kill a live supervised job because its wall deadline moved. A launch
latch prevents execution until every
group lease binding has been persisted. Timeout/cancellation of a started mutation
returns `uncertain` and `readback-before-retry`; an unchanged guarded mutation
cannot redispatch. Observe the remote head and reconcile the effect before
supplying a changed actionable dependency pin. A timer alone cannot clear it.

Agent admission now requires an explicit `resources` configuration: `capacity`,
`agentUnits`, and `browserConcurrency`. All workers on one host share one state
root. Admission reserves agent plus test-child units atomically before spending
model budget. It observes existing Node test launchers and browser roots, counts
unmanaged children, excludes duplicate descendants, and charges observed excess
above an owned reservation. Unknown process observations refuse admission.
The example values are configuration examples, not qualified host tuning.
Keep the supervising host's release/load governor: this change counts test
compute but does not replace its release-priority policy or pause existing work.

Install the maintained `review-pr.sh`, `codex-guard.sh`, `pr-loop.sh` and their
shared `factory-entry.sh` through the existing drained cutover above. No live
wrapper was edited by this source change. The new `test-browser.sh` invokes
`bin/browser-suite.mjs` for an independently scheduled browser suite:
`test-browser.sh owner/repository <explicit-test-files...>`. It reserves its
worker count and invokes Node with explicit test file concurrency. The wrapper
reports result counts and exit status; test names, console output and
error payloads never enter the wrapper's output. Zero acknowledged results fail.
The private `FACTORY_BROWSER_CONCURRENCY` override may lower that count, but cannot exceed
the configured reservation. A guard already reserves its own test children;
its tests should use that exported concurrency in their Node invocation,
rather than nest another standalone reservation. Existing ungoverned test
launchers remain visible to subsequent admission. This is a cooperative host
budget, not OS isolation or a promise to prevent arbitrary detached work.

Before choosing production concurrency or shortening healthy job caps, run
matched same-source/cache/load browser suites at 1 and 2, retaining test union,
timeouts, duration, and host load. The committed fixed-load four-file replay
checks both modes and child peaks; it does not qualify the product's full browser
suite or establish the audit's weekly savings. Factory CI has a 15-minute outer
job deadline and a five-minute install deadline; the factory's Node test command
also limits file concurrency to two. Keep required CI coverage intact.
