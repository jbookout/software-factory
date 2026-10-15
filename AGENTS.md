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

## Standards from the 2026-10-05 review retro

Counts are distinct blocking findings in the harvested review history; repeated
confirmation of the same finding counts once. The retro PR carries the source
comment links and follow-up scopes. Each rule below is required.

- Keep each validation rule in one owner; reuse schemas/helpers and remove dead paths (18 findings).
- Snapshot caller-owned inputs before the first await and derive outputs only from that snapshot (5 findings).
- Resolve paths against the caller's cwd before adapters change it; enforce physical ownership and publish immutable evidence atomically (12 findings).
- Bound the whole operation, including admission, reads, callbacks and cleanup; retain child ownership until termination is observed (13 findings).
- Sanitize sensitive diagnostics before every log, receipt and error sink, including nested fields (6 findings).
- Authenticate executable inputs and installation bindings before evaluating their code; never use an unbound fallback (3 findings).
- Reject malformed or incomplete inputs explicitly; unknown, missing and invalid must never become success (22 findings).
- Exercise the production guard with a valid control and one defect per fixture; require the expected refusal reason and count executed test bodies (4 findings).
- Derive success from bound artifact bytes and exercised operations, including required traps, stored values and producer outcomes (22 findings).
- Bind evidence to source, target, policy and destination; reobserve mutable bindings immediately before effects (29 findings).
- Keep pending, failed, unknown and complete distinct; incomplete observations must preserve known evidence and missing denominators (21 findings).
- Persist intent before effects; reconcile interruption before retry and test contention, cancellation, recovery and fairness (28 findings).
- Parse supported syntax with its parser and normalize equivalent forms; report unsupported forms as unmeasured (12 findings).

`test/schema-artifact-authority.test.mjs`, included in `npm test`, rejects
inline copies of two-field artifact contracts, missing local owners and unused
owners. Different artifact formats remain separate contracts. This check does
not establish semantic correctness or detect duplicated JavaScript/Python rules;
its failing fixtures cover structural detection and its passing fixtures cover
annotations and extended evidence records. Change or remove this repository
policy and its selftests together; it is not a required product template.

## Before every PR: design and debt pass

Before opening or updating any pull request, apply both skills to the diff:

1. `codebase-design`: deep modules, real seams, design the interface twice when it matters.
2. `zero-tech-debt`: rework the change from its intended end state; delete dead compatibility paths and duplicated rules.

Both are installed at `~/.agents/skills/` (sources: github.com/mattpocock/skills `skills/engineering/codebase-design`, github.com/jnsahaj/skills `skills/zero-tech-debt`). The PR reviewer checks both, so all two are required.

When running checks, reviewing their results, or preparing delivery, use `npm run check`. Validate its producer/source/log receipt before reporting coverage.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues for `jbookout/software-factory` (the `gh` CLI). PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). Only `wontfix` exists as a GitHub label today; the other four are not yet created. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: a root `GLOSSARY.md` and `docs/adr/`, both created lazily. See `docs/agents/domain.md`.
