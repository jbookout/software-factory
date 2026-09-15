# AGENTS.md

## Purpose

This repository is Joe Bookout's reusable development-time software factory:
an orchestrator and toolchain for building, testing, reviewing, and shipping
DoctorCRE, other CARR software, and unrelated products. The governing
architecture decision is `1ceee300-7627-426f-b729-ab339d6984fc`; the initial
placement contract is CARR doctrine section
`3bb51d3e-2661-4ea2-a585-053540545b5d`.

## Boundaries

- The factory may own bounded agent workflows, skills, prompts, templates,
  scaffolds, CI conventions, review methods, evals, release helpers, indexing
  tools, and its own job/evidence records.
- It owns no product runtime, product production data, CARR domain rule,
  product roadmap, standing product credential, or deployment authority.
- A product must remain buildable, operable, testable, and supportable without
  the factory running.
- CARR's runtime control plane and assurance fabric remain in
  `jbookout/carr-system`.
- Runtime extraction requires a second real production consumer and a neutral,
  stable, independently pinnable, testable, and replaceable contract with
  measurable duplication.

## Working rules

- Prefer the smallest dependable solution. Complexity must buy measured value.
- Give agents bounded specialist roles, explicit inputs and outputs, falsifiable
  completion criteria, and stop conditions.
- Never fabricate evidence or hide failures. Recommendations may be overridden
  by Joe; security, legal, licensing, credential, and evidence-integrity
  boundaries may not.
- Never commit credentials, production data, client data, or private research
  material. This repository is public.
- Research and swipe-file material must preserve provenance and license status;
  link rather than copy unless reuse rights are verified.
- Use an isolated branch or worktree, relevant local checks, a pull request,
  green hosted CI, merge, and delivery verification.
- Durable factory knowledge belongs in the future isolated factory record
  store. Do not use Markdown as a substitute for job, eval, evidence, or
  provenance records.

## Enforcement model

- Agent instructions explain intent and repair paths; they are not enforcement.
- Put every mechanically decidable product rule behind a deterministic,
  repository-local check that runs in hosted CI. Examples include dependency
  direction, module visibility, forbidden imports, schema compatibility,
  migration safety, and design-system usage.
- Product repositories own their architecture policy, tool configuration,
  dependency pins, exceptions, and merge gates. The factory may qualify tools
  and emit starting configurations, but products must keep enforcing their
  rules when the factory is absent.
- Prefer the ecosystem's smallest mature checker. Do not build a universal
  architecture engine when ArchUnit, Spring Modulith, dependency-cruiser,
  import-linter, a compiler, or a focused test can enforce the rule directly.
- A passing structural check proves only the encoded invariant. It does not
  approve the product design, user experience, new theme tokens, or an
  architecture rule that was never encoded.
- New enforcement adapters begin as non-blocking pilots. Promote one to a
  required template only after a representative fixture proves detection,
  actionable failure output, clean-code acceptance, version compatibility,
  acceptable runtime, and a documented escape/removal path.

## First capability

Deepen the existing DoctorCRE v5 R3 pilot rather than create another indexing
initiative. The factory may provide a disposable, commit-bound index generator,
schema, adapters, and evaluation harness. Each product repository owns its own
configuration and derived artifact. The pilot must beat `rg` and
language-symbol baselines on representative work or be retired; it is never a
merge, release, repository-creation, or runtime prerequisite.
