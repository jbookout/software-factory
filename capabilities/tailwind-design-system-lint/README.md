# Tailwind design-system lint qualification

Status: pilot. This capability qualifies `@shadcn/lint` 0.1.0 for projects
that already use Tailwind v4. It does not recommend adopting Tailwind and is
not applicable to the current DoctorCRE application.

The product repository owns the final rules. Start with the fixture's narrow
policy, replace its generic repair text with the product's actual components,
variants, tokens, and file paths, and put the command in that product's hosted
CI. Never make the product call back into the software factory at build time.

The qualification proves that the pinned package:

- accepts an on-system component use;
- rejects appearance overrides, raw colors, arbitrary values, and dynamic
  component classes; and
- returns rule identifiers and repair-oriented messages an agent can act on.

It does not prove coverage of plain CSS, imported class values, newly declared
theme tokens, disabled rules, or every framework layout. Those are explicit
upstream limits. Current upstream issues also show false positives and theme
resolution failures. Keep the adapter opt-in until representative product
fixtures pass and the relevant defects are fixed or locally guarded.

Primary sources:

- <https://github.com/shadcn-ui/lint>
- <https://github.com/shadcn-ui/lint/blob/main/docs/evals.md>
- <https://x.com/shadcn/status/2099534231114314145>
