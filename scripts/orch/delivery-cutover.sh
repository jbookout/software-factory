#!/bin/sh
# CUTOVER_SIMULATE logs process/launchd effects. Installation, state transfer
# and GitHub smoke reads execute; rehearsals must use a copy of OLD.
set -eu
FACTORY=${FACTORY:-$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)}
if [ "${1:-status}" = flip ] && [ "${CUTOVER_SIMULATE:-0}" != 1 ] && [ ! -d "$FACTORY/node_modules/ajv" ]; then
  npm ci --prefix "$FACTORY" --ignore-scripts || exit 9
fi
exec node "$FACTORY/bin/delivery-cutover.mjs" "${1:-status}"
