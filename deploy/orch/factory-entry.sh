#!/bin/sh
# All PR entry points use one factory version and private state directory.
export CARR_JEV_WORKER=off
if [ -z "$FACTORY_ROOT" ] || [ -z "$FACTORY_PR_CONFIG" ]; then
  echo "FACTORY_ROOT and FACTORY_PR_CONFIG are required" >&2
  exit 9
fi
exec node "$FACTORY_ROOT/bin/pr-delivery.mjs" "$FACTORY_PR_CONFIG" "$@"
