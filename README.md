# Software Factory

This repository will contain a reusable development-time system for building,
testing, reviewing, and shipping software with bounded specialist agents.

It is a toolchain, not a product runtime. Products own their data, domain
behavior, deployments, and operational authority, and must remain
self-sustaining when the factory is absent.

The initial capability will be the already-approved DoctorCRE v5 R3
code-relationship-index pilot. It will be measured against ordinary search and
language-symbol tooling and removed if it does not provide enough value.

The repository is publicly visible. No open-source license has been selected;
public visibility alone does not grant reuse rights.

## Client presentation skill

The portable [Client Presentation skill](capabilities/client-presentation/SKILL.md)
guides agents through source-backed market and property reviews. It includes a
configurable browser starter, ownership-scenario arithmetic and delivery checks.
Its worked example is fictional; client data and hosting authority remain in
the generated client workspace. Read the entrypoint to build a review or install
the complete folder in a supported agent skill directory.

## Finish line

The [finish line](docs/finish-line.md) gives each declared capability a reproducible
done test, implementation evidence, dependencies and remaining effort. It also
orders the PR delivery loop and Design Manager ahead of the remaining work and
states the dated completion arithmetic. `npm test` checks scope-row coverage.

## Loop budgets and receipts

`createFactory().run(job, adapter)` defaults to three verification rounds and two
review rounds. Each failing round permits a repair only when another round
remains. Repeated findings stop at the first repeated round; a missing check or
repair stops immediately. Optional `job.budgets.verificationRounds` and
`job.budgets.reviewRounds` use the [job schema](schemas/factory-job.schema.json)'s
integer range of 1–10. Invalid budgets are rejected before clock, ID or adapter
work. The [budget acceptance test](test/acceptance/loop-budgets.test.mjs) checks
exhaustion, stall, missing steps, invalid input and final-round success.

The public import exports `verifyFactoryReceipt(receipt, trustedDigest)`, which
returns a boolean. Supply the original `receiptDigest` retained in a separately
trusted location; passing the digest from the receipt being inspected provides
no protection against a rewritten payload and checksum. The verifier compares
the embedded digest and SHA-256 of `JSON.stringify` on every receipt field except
`receiptDigest` with that trusted digest. JSON serialization/parse preserves the
property order used by this checksum; reordering object properties changes it.
Missing/malformed input or digest returns `false`.

This is an unkeyed checksum: it detects changes against a trusted original digest,
does not authenticate an author and cannot prevent someone computing a new
checksum. It binds evidence references, without checking their contents or
availability. The [receipt acceptance test](test/acceptance/tamper-evident-receipt.test.mjs)
compares fixed expected bytes and checks round trips, mutations and rewritten
checksums through the public verifier.

## Before/after evidence

A pass label is not evidence. A script step that exits zero without printing a
result fails, and a malformed `evidence`, `findings` or `proposals` list is an
error rather than an empty one. A build passes only when it reports
`data.candidateRevision`, different from `job.sourceRevision`, and a SHA-256
`data.buildDigest`.
The Codex producer schema and prompt require both fields. Every successful
repair rebuilds the candidate; review repairs also rerun verification and risk
inspection before another review round when the revision or build digest changes.
Verification shares the job's original round budget across rebuilt candidates.

Bug work, and work with an interface signal, needs a frozen `job.criterion`
(`id`, `expectation`) before any evidence step runs. Each evidence step returns
`{ kind: "observation", criterionId, artifact: { ref, digest } }` records. The
factory reads those bytes through `createFactory({ readArtifact })`. The CLI builds
that reader from the product profile's `evidenceRoot`, a store outside the
disposable environment. Each artifact must be a `factory-observation.v1` record
from the [evidence schema](schemas/factory-evidence.schema.json). `evidence:before`
must observe `failed` on the source revision for bugs. Other interface work may
observe either `passed` or `failed` to capture prior behavior. `evidence:after` must observe
`passed` on the candidate's revision and build digest, and must not reuse a
before-phase artifact. Attachments such as screenshots are read and digest-checked.
The run snapshots its job and sends independent requests to adapters; evidence
acceptance retains its own criterion and candidate bindings across asynchronous reads.

The filesystem reader requires Python 3 on macOS/Linux. It pins the store's
identity and opens each path component through held directory descriptors with
`O_NOFOLLOW`, rejecting symlinks and non-regular files. Each artifact is limited
to 10 MiB; each acceptance phase and filesystem read has a five-second deadline.
Callers may set `evidenceLimits: { maxBytes, timeoutMs }` on `createFactory` or
pass those options to `createArtifactReader`. Injected readers return a `Buffer`
or `null` and receive `{ signal, maxBytes, timeoutMs }` as their second argument.
They must bound allocation and honor cancellation; acceptance independently
rejects oversized/malformed bytes and stops waiting at its deadline. A timeout
is `blocked`, malformed bytes are `failed`, and disposal runs from `finally`.

The receipt's `evidenceAcceptance` holds each phase's typed verdict (`passed`,
`failed` or `blocked`) with reasons and the accepted artifact digests. With no
reader, or an unreadable artifact, the result is `blocked`. Digests bind bytes:
this rejects labels and stale, copied or edited artifacts, but it does not
authenticate who wrote an observation. The
[acceptance test](test/acceptance/before-after-evidence.test.mjs) covers no-op
builds, empty evidence, empty stdout, stale screenshots and forged passes.

## Design Manager contract pilot

The [implementation plan](docs/design-manager/plan.md) maps the approved
blueprint to ordered slices and verification criteria. The first slice exports
typed lifecycle, tier, role, evidence and gate contracts through
`software-factory/design-manager`, with a strict project-record schema and
adjacent-stage helpers. Run `npm test` to check the contracts. These records
describe design work; they do not dispatch specialists, authenticate evidence,
certify acceptance or grant production authority.

[Entry playbooks](docs/design-manager/entry-playbooks.md) build on those contracts
with one-question interview snapshots, explicit tier and workflow assurance,
entry-specific artifact inputs, lowest unsupported layer diagnosis, revision-bound
dependency reassessment, pending required work and visible scope expansion.
Initialization is pure bookkeeping; durable journals and execution remain later
slices.

[User settings and cloud qualification](docs/design-manager/settings-cloud.md)
add editable station workers/modes, frozen version/digest bindings and a bounded
synthetic CLI harness. Account and background-runtime qualification remain
blocked until live lifecycle, usage and laptop-off evidence passes.

## Deterministic enforcement

The factory treats agent prompts and skills as guidance, not architecture
controls. Product repositories own executable CI gates for rules a machine can
decide: module dependencies, allowed imports, contracts, migrations, tests,
and design-system constraints. Factory capabilities qualify suitable tools and
provide self-contained starting configurations; generated products retain and
run those checks without the factory.

The first enforcement qualification is `@shadcn/lint` for Tailwind v4 design
systems. It is a pilot, not a default: the package is new, current DoctorCRE
does not use Tailwind, and the upstream issue tracker already contains young-
project compatibility defects. Run `npm test` to reproduce the bounded local
qualification.

## DoctorCRE Model Room routing pilot

`readPinnedContract` loads an excerpt from an exact Git commit. A build-task
orchestrator passes those excerpts and authenticated evaluation outcomes to
`routeDoctorCreBuild`. In `qualified_only` control mode, Jev receives only the
current baseline and candidates that meet the deterministic case floor. It
selects the production route from that eligible set and returns its typed
preference, probabilities, and a digest of the state sent to Jev.

Control requires at least three distinct successful cases authenticated by the
evaluator's HMAC bundle, `qualified_only` in the product profile, and the
bundle's matching control policy. Failing cases invalidate a route's counted
passes. Missing or invalid evidence, a Jev outage, and an invalid Jev answer all
return the existing baseline. The factory owns neither credential: callers
supply `TYPESAFE_API_KEY` and `MODEL_ROOM_EVALUATION_KEY` at runtime.

The initial DoctorCRE PR #44 and #45 replays did not qualify either desk.
Both failed an independent held-out check without the exact CARR contract;
both passed the PR #45 check after that contract excerpt was supplied. No
alternative route is currently qualified, so production control selects the
baseline until authenticated checked outcomes qualify another route.

For an attended DoctorCRE build job, set `product` to `DoctorCRE` in the job
and add `modelRoom` to its product profile with `enabled`, `controlMode` set to
`qualified_only`, `baseline`, `candidates`, and `contracts` entries. Each contract names a local Git root,
40-character commit, path, and inclusive line range. `commands.build` may map
exact `provider/model/effort` keys to argv arrays. The factory CLI reads those
contracts, calls Jev with `TYPESAFE_API_KEY` when available, records the
decision in its receipt, and passes the selected route to the build adapter.
Jev outages are visible as `unavailable`; a missing contract stops the job
before build.

An independent evaluator writes an observations document containing `control`
and `observations`, then signs it without exposing the key:

```bash
MODEL_ROOM_EVALUATION_KEY=... npm run model-room:evidence -- sign observations.json bundle.json
```

Set `modelRoom.evaluationBundle` to that bundle's path. The attended CLI
authenticates it before any candidate can enter Jev's choice set; tampering or a
missing runtime key leaves only the baseline eligible.

Profiles may also list up to four exact Git excerpts in `modelRoom.optionalContext`.
Jev chooses `hide`, `short`, `long`, or `full` for each optional excerpt for the
current task. The build request always includes every required contract in full;
optional excerpts are omitted when Jev is unavailable or returns an invalid
answer. Receipts record each choice and source digest, while the excerpt text
stays only in the build request. This trims build context without treating Jev
as an authority over required contracts or model qualification.

### Steering removal replay

`replaySteeringRemoval` extends the pinned-context evaluation path with paired,
bounded trials. It removes exactly one sentence from one committed excerpt;
the task, role, evidence contract, checks, model and effort stay identical.
Repeated pairs alternate arm order. An evaluator reads each response artifact
through the existing digest-bound reader and grades task success, false
running/done claims, rule violations and required source discovery. The model
does not grade itself. Missing evidence, model readback or source discovery
prevents a removal proposal. Any measured behavioral change keeps the line.
Authority, credential and evidence-integrity boundaries always stay.

The [replay command](scripts/steering-removal.mjs) takes a private
plan, a local evaluator module and a new private report path:

```bash
node scripts/steering-removal.mjs /absolute/plan.json /absolute/evaluator.mjs /absolute/report.json
```

The plan supplies `steering` (`root`, exact `sourceRevision`, `path`, inclusive
`startLine`/`endLine`), `line`, evaluator-owned `boundary`, `route`
(`provider`/`model`/`effort`), `artifactRoot`, and `tasks`. Each task names `id`,
`recordedSource` (`ref`/SHA-256 `digest`), `role`, `input`, `evidenceContract`
and `checks`. `repetitions` defaults to two and is capped at ten; at most eight
tasks run. `timeoutMs` defaults to 60 seconds and is capped at 120 seconds.
An optional `runId` binds a reproducible experiment; otherwise a fresh ID is
generated. Keep recorded transcripts, adapted inputs and receipts private.

The evaluator exports `execute(request, {signal, timeoutMs})` and
`judge({request, response})`. Execution uses the caller's sanctioned Model Room
desk and writes an artifact under `artifactRoot`, returning `{ref, digest}`.
The artifact contains the exact `requestDigest`, verified `routeReadback` and
nonempty `result` text. The independent judge returns `taskSuccess` and
`requiredSourceDiscovery` booleans plus nonnegative `falseClaims` and
`ruleViolations` counts, derived from evidence it actually reads. Agent claims
of having read a source do not prove discovery. The command hashes the evaluator
module as `evaluatorDigest` and binds it to the experiment and every trial.
Direct callers supply that digest; record dependency revisions with the trial
evidence. Invocation failure or timeout stops further trials;
observe the desk before any retry. A pending report is preserved and cannot be
overwritten by this command.

The report is a bounded, model-relative proposal. Equal failures and missing
observations are `insufficient_evidence`; successful equal pairs may yield
`propose_removal`. The command never edits steering or replaces mechanical
policy with pointers. Broader removal and pointer replacement require their
own representative trials and check/repair route tests.

## PR delivery

The [PR delivery CLI and cutover note](docs/pr-delivery-cutover.md) port the
review, repair, usage guard, worktree, and serial merge queue into tested Node
modules. [One private configuration](config/pr-delivery.example.json) maps
repositories to local checkouts/worktree roots and configures model, effort,
holds, and limits. The delivery adapter uses the factory's `execute` seam;
build and delivery share the shell-free Codex process runner. Offline CLI tests
use temporary Git remotes and fake `gh`/`codex`, and run in `npm test`.
