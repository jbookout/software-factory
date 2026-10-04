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
repair head without a tested finding-resolution receipt exits 2 (`NO-PROGRESS`), exhausted usage/slots exits 75, timeout exits
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

## Finding receipts and builder preflight

All builder and review entry points share
[the receipt schema](../schemas/pr-delivery.schema.json). A blocking review
includes a one-line `Delivery-Brief` manifest whose IDs match every numbered
finding. It binds the original reproduction, owning repository/paths, consumer
revision, contract pin, reviewed head and review bytes. Legacy blocking comments
without that manifest refuse dispatch until the orchestrator supplies the
missing binding; the factory never guesses an owner from prose.

Fix workers return `{fix, selfReview}` JSON. The adapter replays each original
command on its original and repaired sources in disposable detached worktrees,
verifies claimed changed paths against Git, and pins the consumer worktree too.
Commands receive `FACTORY_PROOF_HEAD`, `FACTORY_CONTRACT_PIN`,
`FACTORY_CONSUMER_HEAD` and `FACTORY_CONSUMER_WORKTREE`. Each reproduction prints
its exact acknowledgement after checking the property, exits 1 for the failing
control and 0 for the repair. Empty, partial, refused, timed-out or exceptional
results never count. A reseal or main merge with the same defect cannot pass.
Modified proof source is retained for diagnosis rather than discarded.

Foreign findings create one owned wait with the finding ID, original head/pin,
deadline and `owner-tested-pin-receipt` next action. They launch no wrong-repo
fixer. Configure the owning and consuming repos, then use
`node "$FACTORY/bin/pr-delivery.mjs" "$CONFIG" resolve-findings "$R" "$N" "$RECEIPT"`
to replay the executor's tested pin receipt. Confirmation requires every finding
resolved at the current PR head. Unchanged head/finding/evidence admits one
confirmation attempt; a tested foreign owner pin wakes the recovery loop even
when the local PR head stays unchanged. A distinct reviewer still checks the
repair and CI.

Before creating a PR, the external builder calls
`node "$FACTORY/bin/pr-delivery.mjs" "$CONFIG" builder-preflight "$R" "$RECEIPT"`.
This command validates and replays a `factory-self-review/v1` receipt against
the pushed head, current `origin/main` and actual Node/platform environment.
It does not create a PR or a review comment. The builder remains responsible
for calling it before PR creation; the factory does not intercept arbitrary
`gh pr create` calls. Repair workers invoke the same admission automatically.
The local pass uses the identical full-review checklist without its posting
instruction. Each heading references executed checks; each N/A gives its failed
relevance test. Repairs reference the same failing/repaired reproduction.
Fixture ownership, resources, selection dependencies and the six builder
requirements are mandatory. Product-owned `instructionSurfaces` may list
registered steering file paths in repo config; an intersecting diff must carry
executed instruction-eval checks.

New proof records persist command/output/issue digests and execution results,
not raw subprocess diagnostics or repair narrative. They include replay time,
check and repaired-issue counts; unreported model tokens remain unknown.
Rollout comparison must still measure paired defect detection, false blockers,
first-review findings and total model usage. Builder proof has role `builder`;
only a fresh factory reviewer execution with role `independent-reviewer` can
satisfy approval provenance. Earlier reviewer receipts without that role require
a new independent review. These are source capabilities and replay evidence;
installation into the active orchestration directory remains the orchestrator's
cutover operation.


### Executable finding admission and replay isolation

A blocked comment is executable input only when its exact bytes have a verified
local independent-review receipt, or GitHub REST attributes it to a numeric user
ID in that repository's `trustedReviewerIds`. This optional allowlist admits
external orchestrator briefs; an empty list permits only verified factory
reviews. A login, association, quoted marker or syntactically valid brief alone
cannot grant executable admission. Approvals still require factory execution
provenance, even for allowlisted users.

All receipt replay uses a clean environment and a platform sandbox:
macOS Seatbelt (`/usr/bin/sandbox-exec`) or Linux Bubblewrap (`bwrap` with working
unprivileged user namespaces). CI installs Bubblewrap. Unsupported or unavailable
isolation refuses proof. Replay can read system tooling and its pinned producer
and consumer worktrees, and write only in those disposable trees. It cannot read
the worker's home or shared Git metadata, inherit its credential environment, or
use the network. Checks must use source files and `FACTORY_PROOF_HEAD`,
`FACTORY_CONSUMER_HEAD`, `FACTORY_CONSUMER_WORKTREE`, and `FACTORY_CONTRACT_PIN`;
network fetches, credential access and Git commands requiring the shared `.git`
directory cannot serve as proof. Tracked source mutations still refuse proof and
retain the affected trees for diagnosis. This execution contract applies to
builder preflight as well as original/repaired finding replay.

Both repair and confirmation use the same cached-proof validator. It binds the
canonical finding manifest and rederives the semantic evidence digest from the
current findings and the recorded repaired pins. Local findings must fail on the
reviewed head. A repaired consumer in the reviewed repository must use the
current PR head; the original failing replay retains the original consumer.
Optional notes after `Non-blocking` or `Follow-ups (non-blocking)` do not become
executable findings. Keep reproduction instructions indented beneath their
finding.

Confirmation takes an owned lease before reserving a model run. Its persisted
attempt moves from running to posting to complete, or failed when execution
produces no verified receipt. A failed child with no
verified successful execution can be retried after the prior process group has
ended. A posting interruption first verifies the saved execution artifacts and
observes remote comments: an existing exact comment completes the attempt, and
an absent comment is reposted with the same attempt identity without rerunning
the model. Successful attempts remain deduplicated. Malformed persisted JSON
produces a fixed diagnostic without its input bytes.
