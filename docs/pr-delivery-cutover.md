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

## Evidence navigation

`node bin/pr-delivery.mjs <config.json> installation-status` identifies the invoked
factory HEAD revision, entry point, configuration, required checks, and evidence paths.
Installation remains unverified. The output does not compare an installed worker
with its intended deployment.

`node bin/pr-delivery.mjs <config.json> job-status <repo> <pr>` adds that PR's
recorded queue transitions, wait, repair, and worker/check receipt and log paths.
Absent records return empty or null values. Paths can name files that do not exist.
Recorded history does not establish process liveness or current GitHub state.
The separate file reads are not an atomic snapshot of concurrent delivery work.

These commands read local metadata without GitHub calls, leases, state creation,
or error-log writes. They select journal fields and return log paths without
reading log contents. Malformed or mismatched journals fail with exit code 9.
`queue-status` remains the aggregate queue diagnostic and can recover leases.
