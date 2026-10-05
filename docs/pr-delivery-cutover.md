# PR delivery cutover

The orchestrator performs this cutover after merge. Node 20.19+, Git with
`merge-tree --write-tree`, `gh`, and `codex` must be on PATH. Authentication
stays in the caller's environment/tool configuration; never put credentials in
JSON. Copy [the example](../config/pr-delivery.example.json) to a private local
config. It is the only repo registry: set each `checkout`, `worktreeRoot`, the
shared `stateDir`, model, effort, limits, and holds (`repo`, `titlePattern`,
`reason`). Include `jbookout/software-factory` with its own checkout; the example
registry lists all three code homes. Set `trustedReviewers` to the verified
GitHub logins used by the review poster (case-insensitive). This allowlist
identifies whose verdicts count; approvals still need the private independent
execution receipt. The latest trusted blocking verdict needs no approval receipt
and defeats every older approval. Verdict order uses comment creation time and
ID; editing an older comment cannot move it ahead of a newer block. Each repository must also name its `requiredChecks` as
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
Imported approval comments never authorize delivery. Trusted blocking comments
remain blocking; an untrusted author cannot approve or impersonate a blocker. Run a fresh factory review
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
| `merge-queue.sh` | `node "$FACTORY/bin/pr-delivery.mjs" "$CONFIG" merge-queue "$R"` (one consumer per repository) |
| `merge-one-core.sh R N H note` | `node "$FACTORY/bin/pr-delivery.mjs" "$CONFIG" merge-one-core "$R" "$N" "$H" "$NOTE"` |
| `merge-enqueue.sh R N H note` | `node "$FACTORY/bin/pr-delivery.mjs" "$CONFIG" merge-enqueue "$R" "$N" "$H" "$NOTE"` |
| `auto-enqueue.sh` | `node "$FACTORY/bin/pr-delivery.mjs" "$CONFIG" auto-enqueue` |

Set `KIND` and the `COMMAND` argv array for the guard. Replace the loop's `3`
with the existing caller's round limit. `branch-wt` takes the configured repo
identity instead of a checkout path. `ci-fix` re-enters the PR loop; `--no-loop`
disables that for a caller already controlling rounds. Queue/auto-enqueue accept
`--once` for supervised checks. Never use GitHub auto-merge. Each repository has
its own integration lease, shared by its queue consumer and direct merge-core
calls; both also take the PR writer lease that fixers hold. Every GitHub write
runs under the process supervisor bound to both leases, so a dead controller's
ownership survives until its write job is gone. A behind-main head receives one
update request. Accepted or ambiguous responses
remain pending until a changed head proves the approved-head/main-merge relationship;
consumer restarts reconcile the stored intent without repeating the write. Old-head
CI is not consumed while pending. The integrated head requires fresh review
and CI of the integrated tree. Merging requires an
active `main` ruleset with strict required status checks that the merging
identity cannot bypass, so GitHub itself refuses a merge after main moves; the
delivered squash parent must equal the recorded integration base. Review uses a fresh,
detached worktree and process; builders never post approvals. Queue approval
attestations cannot substitute for independent review comments. Each review uses
a unique attempt directory; live, dirty, or interrupted attempts are preserved.
Accepted approvals carry a `Factory-Review` reference to private execution,
source tree, prompt, and exact reviewer output records. Keep these records in
the shared state directory. A matching GitHub author name alone cannot authorize delivery.
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

## GitHub snapshot and verdict cutover

`src/github-snapshot.mjs` owns all provider reads and REST writes. The loop,
review, readiness, enqueue and merge entry points consume its typed
`factory-github-snapshot/v1` result. `snapshot R N [H]` prints the complete
read-only observation for private diagnostics; it includes public provider
bodies, so keep its output out of public receipts. Unknown observations expose
only sanitized errors and no usable source bindings. The types are in
`src/github-snapshot.d.mts`.

Known observations bind repository/PR, full head and base SHA/ref/repository,
PR state/draft/mergeability, all comment/check/status pages, the named required
inventory, fetch time and latest trusted verdict. The reader validates provider
counts, duplicate IDs and advertised pagination links, and fences the observation
with a second PR read and reads of the live target ref before and after collection.
The PR response’s recorded base remains diagnostic; action checks bind the live
target SHA. A changed source/base/state/comment count or policy is
unknown. This is a REST observation, not an atomic provider transaction. Every
write rechecks current preconditions; merge also sends the full head SHA as the
provider compare-and-swap. REST cannot mark a draft ready: draft delivery refuses
before a merge write. The orchestrator must account for that REST limitation
when selecting candidates.

There is no durable snapshot cache. Concurrent readers in one adapter coalesce
in-flight observations; later ticks and action checks fetch mutable verdicts and
checks again. Local review/CI predicates reuse one snapshot rather than fetching
checks independently. Scans skip held candidates and, when the list supplies a count, PRs with no
comment history. Approval-gated scans return an explicit `refused` snapshot for
unapproved candidates, with checks `unobserved` and null check inventories; they
spend no check/status calls. Refused/unknown evidence never authorizes an action
or substitutes for a full observation.
Private `delivery.jsonl` observation events emit `observationId`, `providerCalls`,
`staleActions`, fetch time and sanitized errors. Deduplicate observation IDs when
aggregating shared reads. A stale precondition event refuses the effect
and requests another observation. Compare these counters and failed rounds on
matched rollout cohorts; the audit's 18-to-about-10 target is a forecast, not a
measured result of fixture tests. Cross-process snapshot caching is not provided.

REST writes are not blindly retried. A lost/empty merge acknowledgement triggers
a fresh PR read and Git ancestry/source-tree verification; an already merged
retry verifies the same delivery and emits no second merge. A failed API body
never supplies a Git ref.

Install using the maintained `deploy/orch/` cutover above after draining current
workers. Pin `FACTORY_ROOT` to the delivered revision and set every caller's
`FACTORY_PR_CONFIG` to one updated private registry with the current named checks
and verified review posters. Copy the entire wrapper set together, including
`factory-entry.sh`; retain previous wrappers for rollback. This source change
does not modify running `carr-system/out/orch` scripts, start workers, or change
product deployment authority.

Malformed attempted review envelopes from trusted authors invalidate older approval,
including SHA-only comments and whitespace-damaged verdicts. Ordinary notes remain
ignored. Missing local receipt source objects refuse that approval while keeping
readiness and fresh review reachable; fresh review fetches and verifies its source.
