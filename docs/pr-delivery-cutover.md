# Delivery installation

Install a committed factory revision in a dedicated checkout, run `npm ci`, and invoke
`node /absolute/path/to/installed-factory/bin/pr-delivery.mjs /absolute/path/to/config.json deliver --once`.
Keep the previous checkout and its config. Roll back by invoking the previous entry point with that config path.
Never run a second delivery worker against the same configuration.

The config lists the three repositories, their check commands and required hosted checks.
The serial worker repairs only observed failed checks, up to three rounds by default.
A pending branch update, push or merge is read back before another action.
Unknown provider outcomes remain pending. Green hosted CI on the exact candidate is required to merge.
Factory delivery never deploys a product or changes its credentials.
