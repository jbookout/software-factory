# Worker settings

Edit the workers in `config/design-manager/joe.example.json` and load the chosen file with `loadDesignSettings`.
Each worker names its provider, model and effort. Settings do not grant credentials or production authority.

At the authorized Model Room cloud desk, run the provider's ordinary smoke test:

```sh
codex cloud exec --env "$CODEX_CLOUD_ENV_ID" --attempts 1 "Return only the sum of 19 and 23. Do not modify files."
```

Retain the provider task ID or task URL printed by the command. An ambiguous submission requires task readback before a retry.
Read the provider's actual model and result. Resume and cancel were unsupported by the attempted Codex cloud route; do not infer them from a successful submission.
Use the provider's native authentication flow.
