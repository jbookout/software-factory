#!/bin/sh
# Run explicit app/browser test files through the factory's compute reservation.
if [ -z "$FACTORY_ROOT" ] || [ -z "$FACTORY_PR_CONFIG" ]; then
  echo "FACTORY_ROOT and FACTORY_PR_CONFIG are required" >&2
  exit 9
fi
exec node "$FACTORY_ROOT/bin/browser-suite.mjs" "$FACTORY_PR_CONFIG" "$@"
