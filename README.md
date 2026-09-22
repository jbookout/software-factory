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
orchestrator can pass those excerpts and independently verified replay outcomes
to `routeDoctorCreBuild`. The function asks Jev for a typed preference among
the current route and candidate desks, and returns the preference with its
probabilities and a digest of the state sent to Jev. The current route remains
selected during shadow evaluation.

Control requires three separate conditions: at least three distinct successful
cases authenticated by the caller's evaluator, an explicit control setting,
and a separate trusted control-policy verifier. Failing cases for a route
invalidate its counted passes. Without those conditions, or when Jev is
unavailable or returns an invalid answer, the function returns the existing
route. The factory owns no product credential; callers supply a TypeSafe key
at runtime and never put it in a job or repository file.

The initial DoctorCRE PR #44 and #45 replays did not qualify either desk.
Both failed an independent held-out check without the exact CARR contract;
both passed the PR #45 check after that contract excerpt was supplied. This
pilot therefore remains in shadow mode until checked outcomes support control.

For an attended DoctorCRE build job, set `product` to `DoctorCRE` in the job
and add `modelRoom` to its product profile with `enabled`, `baseline`,
`candidates`, and `contracts` entries. Each contract names a local Git root,
40-character commit, path, and inclusive line range. `commands.build` may map
exact `provider/model/effort` keys to argv arrays. The factory CLI reads those
contracts, calls Jev with `TYPESAFE_API_KEY` when available, records the
advisory in its receipt, and passes the selected baseline route to the build
adapter. Jev outages are visible as `unavailable`; a missing contract stops
the job before build. The CLI does not enable route control or accept caller
supplied replay qualifications.

Profiles may also list up to four exact Git excerpts in `modelRoom.optionalContext`.
Jev chooses `hide`, `short`, `long`, or `full` for each optional excerpt for the
current task. The build request always includes every required contract in full;
optional excerpts are omitted when Jev is unavailable or returns an invalid
answer. Receipts record each choice and source digest, while the excerpt text
stays only in the build request. This trims build context without treating Jev
as an authority over required contracts or model qualification.
