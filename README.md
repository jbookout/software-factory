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
