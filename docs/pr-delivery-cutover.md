# PR delivery cutover

## Orchestrator switchover: tiered delivery

`deliver R N [W] [rounds]` is the one per-PR entrypoint: admission, tiered
review, fix rounds, then a head-bound enqueue. It never merges. `deliver R` is
the repository lane: approved-head enqueue scan plus the serial merge queue.
`pr-loop.sh` and the new `deliver.sh` wrappers both route to it.

Review depth comes from a `repository-review-decision/v1` record computed with
carr-system's `review-tiers.v1` schema (`src/review-tiers.mjs`, digest-equal to
`lib/review_tiers.py`) over the PR's own change (merge-base..head). Each repo's
`reviewPolicy` names a `repositoryPath` read at the base revision (carr-system:
`ops/config/review-tiers.v1.json`) or a `file` (factory maps under
`config/review-tiers/`). Dispatch tier: carr's bounded tunable-scalar lane and
change sets whose every path matches a rule keep the decision's tier; an
unclassified path, empty change, missing or invalid policy is tier 3.

- Tier 1: no model. Required hosted checks green on the exact head produce
  `APPROVE` / `Reviewed-SHA: <head>` / blank line, a statement that it is a
  tier-1 deterministic approval, the policy and diff digests and
  `Review-Decision: sha256:<decision digest>`; red checks produce a
  deterministic `REVIEW: BLOCKED` that starts a fix round. An earlier blocking
  verdict always gets a model confirmation instead. The receipt is the stored
  decision record.
- Tier 2: one focused review of the changed files and their direct callers.
- Tier 3: the legacy `review-pr.sh` full checklist, verbatim.

Every posted verdict ends with `Review-Tier`, `Review-Decision` and
`Factory-Review` lines and carries no second `Reviewed-SHA` line, as
`ops/release-pipeline.py` requires (tested against its extracted parser in
`test/fixtures/release-pipeline/`).

A `merge-holds.txt` line keeps matching PRs out of the queue. A line whose
reason starts with `FREEZE` also stops merges: the queued entry stays untouched
and the lane retries (exit 75). An unreadable line stops merges too.

Shadow mode, `shadow R`, runs beside the legacy scripts, makes no GitHub write,
and appends one `factory-delivery-shadow/v1` record per PR per pass to
`stateDir/shadow.jsonl` (tier, would-review, would-approve, would-merge, and
the old path's verdict and merge). `bin/delivery-shadow-compare.mjs` reports
agreement. `scripts/orch/delivery-cutover.sh shadow|flip|rollback|status` moves
between modes; it only moves files, into `$OLD/_to_delete/`.

The orchestrator performs this cutover after merge. Node 20.19+, Git with
`merge-tree --write-tree`, `gh`, and `codex` must be on PATH. Authentication
stays in the caller's environment/tool configuration; never put credentials in
JSON. Copy [the example](../config/pr-delivery.example.json) to a private local
config. It is the only repo registry: set each `checkout`, `worktreeRoot`,
`reviewPolicy`, the shared `stateDir`, limits, and `holdsFile` (the
orchestrator's `merge-holds.txt`, read on every enqueue and merge decision).
Models per role come from [delivery-models.v1.json](../config/delivery-models.v1.json)
unless `modelsFile` names another; `codex.command` may name the executable. Include `jbookout/software-factory` with its own checkout; the example
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
Holds stay in `merge-holds.txt`; point `holdsFile` at it. Do not run both queues.
The factory does not install a scheduler or take product deployment authority.

Use `R=owner/repository`, `N=<pr>`, `W=<worktree-or-dash>`, `H=<approved-full-sha>`,
`B=<branch>`, `F=<fallback-worktree>`, and `NOTE=<note>` as invocation inputs:

| Old script | Exact factory command |
| --- | --- |
| `pr-loop.sh R N W [rounds]` | `node "$FACTORY/bin/pr-delivery.mjs" "$CONFIG" deliver "$R" "$N" "$W" 3` |
| `review-pr.sh R N` | `node "$FACTORY/bin/pr-delivery.mjs" "$CONFIG" review-pr "$R" "$N"` |
| `fix-pr.sh R N W` | `node "$FACTORY/bin/pr-delivery.mjs" "$CONFIG" fix-pr "$R" "$N" "$W"` |
| `ci-fix.sh R N` | `node "$FACTORY/bin/pr-delivery.mjs" "$CONFIG" ci-fix "$R" "$N"` |
| `codex-guard.sh R N kind command...` | `node "$FACTORY/bin/pr-delivery.mjs" "$CONFIG" codex-guard "$R" "$N" "$KIND" "${COMMAND[@]}"` |
| `branch-wt.sh repo-dir B F` | `node "$FACTORY/bin/pr-delivery.mjs" "$CONFIG" branch-wt "$R" "$B" "$F"` |
| `merge-queue.sh` + `auto-enqueue.sh` | `node "$FACTORY/bin/pr-delivery.mjs" "$CONFIG" deliver "$R"` (the repository lane; one per repository) |
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
provider failures persist a shared hold; later queue attempts wait until its retry time.
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
After draining active workers, use the source-bound installer:
`node "$FACTORY/bin/orch-install.mjs" install "$FACTORY" "$OLD" "$CONFIG"`.
It retains the previous receipt and wrappers in a revision-named rollback
directory, preserves their source revision in a sibling snapshot, and writes
`.factory-orch.json` beside the installed wrappers. The receipt binds the clean
source revision, runtime hashes, executable hashes, entrypoint, config and private
state location. `node "$FACTORY/bin/orch-install.mjs" check "$OLD"` compares
those artifacts without changing them. A mismatch names the file and requires
reinstalling delivered source. Installed wrappers read their own receipt and
use the installed, builtin-only verifier to check source bytes before evaluating
the PR adapter. Installed entrypoints require a receipt even in a `deploy/orch`
directory; caller environment cannot select a
different factory implementation. Source-directory wrappers retain the existing
`FACTORY_ROOT`/`FACTORY_PR_CONFIG` replay route. Keep config and state outside both
source and installed executables. The installer does not start jobs or a scheduler.

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

`readiness R N [H]` exposes the canonical observation: `green`, `red`, `pending`,
`quota_hold`, `auth_error`, `unknown` or `superseded`. Required contexts must succeed on
the exact current head; skipped/neutral required jobs, cancellation and absent
contexts never authorize enqueue or merge. Optional skipped/neutral jobs remain
accepted. Obsolete heads request observation of the current head and start no
fixer. Current cancellation requests a check rerun; observed assertion
failure in a configured required check remains repairable. All new provider reads use paginated REST checks,
commit statuses, PRs and comments. Malformed/permission responses stop.
CheckRun status and conclusion are validated separately: an unfinished run
must have no conclusion, and only completed success can satisfy a required run.
All factory GitHub reads and writes reserve from one persistent `github.json`
request budget under the shared `stateDir`. Configure `github.requestsPerHour`
and `github.cacheMs`; all consumers must share that directory. REST commit/head
observations share a cache; PR heads and approvals are reobserved before acting.
Writes invalidate cached check evidence. REST and GraphQL evidence keep separate
pool identities, while either pool's quota hold stops requests in both pools.
Quota refusals persist the later of Retry-After, reset time, and pstack's backoff.
Unknown query failures back off for 60, 120, 240, then 300 seconds and terminate
after five query errors. Authentication refusal terminates immediately. Holds
survive process restart. Terminal holds require operator diagnosis and explicit
retirement of the hold after the underlying fault is repaired. Keep request
history when retiring a hold. No provider refusal becomes CI-red.

Use `enqueue-event R N H` for a head-bound event hint. The adapter reobserves
approval and checks; repeated hints for a head are deduplicated even after a
failed queue attempt. Event processing and automatic reconciliation take the
same enqueue-owner lease. Its reconciliation deadline is persisted before each scan, so restart and repeated `--once` invocations cannot scan more often than five minutes.
A CI fixer, including direct `ci-fix`, requires an observed failed required check;
a conflict or optional failure cannot start it.

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

Continuous merge queues keep polling while the PR writer or integration lane is
owned. Contention returns transient code 75 without consuming an entry attempt;
`--once` still exits 75. An uncertain update acknowledgement retains its saved
intent for readback, including a supervised timeout, without another update write.

Malformed attempted review envelopes from trusted authors invalidate older approval,
including SHA-only comments and whitespace-damaged verdicts. Ordinary notes remain
ignored. Missing local receipt source objects refuse that approval while keeping
readiness and fresh review reachable; fresh review fetches and verifies its source.

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
suite or establish the audit's weekly savings. [Factory CI](../.github/workflows/ci.yml)
declares separate install, full-suite and outer job deadlines; the factory's Node
test command also limits file concurrency to two. Keep required CI coverage intact.


## Process and repair receipts

Every guarded job has explicit `caller` ownership. The foreground CLI owns it;
ending that owner interrupts its process group. This release provides no detached
service mode. The supervisor binds a unique job ID, assigned worktree, configured
model and effort, private log, supervisor PID, group PID and deadline. It writes
`running` only after that command acknowledges startup and its log exists.
The supervisor writes the terminal receipt even after the caller disconnects.
Job receipts and logs live under private directories in `stateDir/attempts`. Sensitive-output commands keep
raw stdout/stderr out of logs as well as delivery records; their output digest
remains available. Process scans cannot establish
startup for another job.

Repairs require repository-owned `checks`, a nonempty list of literal argv
arrays, and optionally `checkTimeoutMs`. Use native check entrypoints that report their result on stdout/stderr. Direct
shell launches, shell scripts, and generic launch wrappers are refused because
the launch validator cannot establish ownership of their redirected outputs.
Configure DoctorCRE with its privacy, check, test, build and artifact-verification
commands. Factory configuration includes `npm test`,
the browser-select Python test and orchestration evidence replay steps from its CI.
Install required dependencies before admission. Commands execute in the assigned
worktree, under the existing process supervisor and compute reservations. Explicit
`--output` and `--output-last-message` paths resolve from that child working
directory and must name regular files in the physical attempt directory. Output
symlinks are refused. Commands receive private `TMPDIR` and
`FACTORY_ATTEMPT_DIR` paths; this contract does not sandbox arbitrary program
filesystem access. Repository check code owns its other file writes.

The builder performs focused tests and returns a local commit. The runner owns
full checks, ordinary push and both remote/PR head readback. A remote change
before checks finish produces `early_publication` and refuses delivery. Failed
checks report the observed remote head; they cannot infer unpublished source
from a check's exit code. The runner binds the worktree's effective push URL,
refuses extra destinations, and pushes to that observed URL. It rechecks the
open PR and its branch, repository and base binding immediately before push,
and requires those bindings again in the final readback.

The current repair at `stateDir/repairs/<repo-pr>.json` binds the builder job and
source before dispatch. It transitions through `building`, `checking`,
`check_failed` or `check_interrupted`, `push_pending`, then `delivered`.
`node "$FACTORY/bin/pr-delivery.mjs" "$CONFIG" repair-status "$R" "$N"`
reads that record and current job owner. The installed `unstick` and `stall-watch`
entrypoints discover both waits and incomplete repairs. Recovery observes the
job before retrying. It refuses live jobs and reconciles a committed interrupted
builder to `candidate_unconfirmed`, without repeating the builder or publishing.
An explicit fix request can confirm and finish that retained candidate.
A terminal failed repository check permits a bounded corrective builder on the
retained source under the PR lease and existing admission budget. A changed
check policy can recheck that source without rebuilding. Each new attempt keeps
a new repair ID and names its predecessor. Failed and delivered receipts remain
immutable under `stateDir/repair-receipts/<repair-id>.json`; inbox reports use
those paths, while the current record exists for recovery. Pending pushes read
remote state before another push. Delivery binds the tested commit/tree, check
results and observed remote head; builder prose cannot supply that evidence.

An optional private `orchInbox` configuration names the installed pstack
`orch.ts` executable as `command` and its initialized private `store` directory.
The runner uses its existing `inbox push` command to publish a terminal receipt
pointer for `<repo>#<pr>`. Pstack's verification ledger retains its independent
reviewer verdicts; process completion never overwrites one. This is a pointer
into the existing store, with no copied store implementation or second job DB.

The workflow audit now runs on actual repository workflows in hosted CI as a
non-blocking pilot. Missing action provenance or unclassified shell execution
remains an audit finding; the YAML audit does not certify installed shell behavior.
Installed-wrapper replays provide that separate evidence. To remove the pilot,
remove its optional CI step. To roll back orchestration, drain jobs, reconcile
private queue/usage records and restore retained wrappers as described above.


Local checks use `npm run check` to capture stdout/stderr in a private attempt and
validate the producer, command, outcome, source and log before reporting coverage.
Use `npm run check -- node test/local-verification.test.mjs` for a focused Node
run, or select `browser` and `orchestration` classes. With no arguments, all
classes run.

The source binding fingerprints tracked and non-ignored untracked files from the
repository root, including when the check runs from a subdirectory. Tracked
symlinks, Git submodules and non-file source entries fail closed. Ignored build
outputs and dependencies are outside this source fingerprint. Source is checked
both immediately before dispatch and when reading the result.

`runVerification` returns a digest of the complete producer receipt, including
its exit status. `readVerification` requires that digest as its third argument;
callers retain it from the execution result, never derive it from the receipt
being validated. Editing the receipt, source or capture log invalidates the
evidence. The receipt has no self-authenticating success field.
