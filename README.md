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
