# Software factory

Development tools for building and delivering DoctorCRE and CARR software.
Products run independently of the factory. This public repository contains no product credentials or client data.
No open-source license has been selected. Public visibility alone does not grant reuse rights.

## Checks

Run `npm ci`, then `npm run check`. It runs the Node behavior tests, supervised browser-selector tests and workflow security checks once each.
Each command returns its exit status and a unique output log path. Repository-owned shell check scripts are supported.
Run `npm test` for the Node suite or `npm run check node test/process-runner.test.mjs` for a focused check.
The formatter is pinned. Run `npm run format:check -- <files>` on relevant files. Qualify upgrades when changing the version.
ESLint's design-system rules and representative fixtures remain in `capabilities/tailwind-design-system-lint`.
The direct headless browser tests have their own `npm test` in `capabilities/agentic-ui-evaluation/fixture`.

## Delivery

One serial worker serves the configured CARR, DoctorCRE and factory repositories.
Copy `config/pr-delivery.example.json` outside the repository and set checkout paths, repository-owned check commands and required hosted checks.
Run `node bin/pr-delivery.mjs /absolute/path/to/config.json deliver --once` for one pass, or omit `--once` to keep polling.
`deliver <repo> <pr>` checks and repairs a single candidate, then queues it. `merge-queue --once` consumes the queue.
Repairs stop after three rounds by default and never push until repository checks pass.
Pending branch updates, pushes and merges are read back before any retry. Cancellation prevents later dispatch.
Only green hosted CI on the exact candidate permits a merge. GitHub's rules remain the final merge authority.
The factory cannot deploy a product. Installation and previous-version rollback are described in [delivery installation](docs/pr-delivery-cutover.md).

## Design

The Design Manager is unfinished. Read [the plan](docs/design-manager/plan.md) first: its "Read first" section is the agreed shape for finishing it.
`src/design-manager.mjs` holds the stages, gates and roles; `src/design-verify.mjs` freezes acceptance criteria and checks feature maps; `src/design-journal.mjs` keeps the decision journal.
Worker settings are editable JSON. See [worker settings](docs/design-manager/settings-cloud.md).
Design records use private SQLite and ordinary backup. See [journal](docs/design-manager/journal.md).

## Jobs and Model Room

`npm run factory -- /path/to/job.json` runs the job's build, check, bounded repair and cleanup commands, with ordinary logs.
Jobs provide `root`, optional `rounds` and argv arrays under `commands.build`, `commands.check`, `commands.repair` and `commands.cleanup`.
Model Room routing retains required source context, actual-model readback and usage records. Comparisons are optional experiments, not dispatch qualifications.
Specialist attention is appropriate for credentials, production migrations, privacy, destructive actions and concurrency.

## Capabilities

The [client presentation generator](capabilities/client-presentation/SKILL.md), [supervised Jev browser selector](capabilities/jev-browser-select/SKILL.md) and [design-system lint fixture](capabilities/tailwind-design-system-lint/README.md) retain their direct behavior tests.
Repository boundaries are in [AGENTS.md](AGENTS.md). Current work belongs in [GitHub issues](https://github.com/jbookout/software-factory/issues).
Historical operational studies remain in Git history and are excluded from normal checks.
For runner comparisons, run the same commit on both runners and compare results, elapsed time and billed cost.
