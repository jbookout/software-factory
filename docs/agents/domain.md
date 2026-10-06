# Domain Docs

How the engineering skills consume the software factory's domain documentation.

## Before exploring, read these

- [AGENTS.md](../../AGENTS.md) and [README.md](../../README.md) for factory
  ownership, working rules, and development interfaces.
- Relevant committed capability documentation in `capabilities/` and interface
  documentation in `docs/`, together with their implementation and tests.
- For cross-repository work, the product repository's own instructions and its
  exact source revision and versioned contracts. Product domain rules stay with
  their product authority.

## File structure

Layout: **single-context**. Do not create `GLOSSARY.md`, `GLOSSARY-MAP.md`,
`docs/adr/`, or `.scratch/` knowledge records. [AGENTS.md](../../AGENTS.md)
reserves durable factory knowledge for the future isolated factory record store
and forbids Markdown substitutes for job, eval, evidence, or provenance records.
These agent configuration files describe consumers and destinations only.

No glossary or ADR record-store writer is established here. Continue exploration from
existing boot and interface documentation. When `/domain-modeling` resolves a
factory term or decision, report the missing destination in the delivering PR;
do not create a Markdown record or store factory knowledge as CARR doctrine.
GitHub Issues track development work, not factory job or evidence records.

## Use the glossary's vocabulary

Use terms as defined in the applicable source contracts and documentation;
avoid synonyms that change meaning. An absent definition is a gap for
`/domain-modeling`, subject to the record destination above.

## Flag ADR conflicts

Surface conflicts with recorded decisions, repository ownership, or committed
contracts, naming the decision's subject and a reason to reopen it.
