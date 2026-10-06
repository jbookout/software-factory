#!/bin/sh
# One transactional cutover command. OLD is never touched by a rehearsal unless
# the caller points it at a temporary copy and sets CUTOVER_SIMULATE=1.
set -eu
FACTORY=${FACTORY:-$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)}
if [ "${1:-status}" = flip ] && [ "${CUTOVER_SIMULATE:-0}" != 1 ] && [ ! -d "$FACTORY/node_modules/ajv" ]; then
  npm ci --prefix "$FACTORY" --ignore-scripts || exit 9
fi
exec node "$FACTORY/bin/delivery-cutover.mjs" "${1:-status}"
