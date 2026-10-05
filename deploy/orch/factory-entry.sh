#!/bin/sh
export CARR_JEV_WORKER=off
DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 9
RECEIPT="$DIRECTORY/.factory-orch.json"
# Installed entrypoints always read their own binding. A removed receipt refuses.
if [ -f "$RECEIPT" ]; then
  exec node "$DIRECTORY/factory-verify.mjs" "$DIRECTORY" "$@"
fi
# Source adapters support repository replay only. Installed copies cannot fall back.
if [ -n "$FACTORY_ROOT" ] && [ -n "$FACTORY_PR_CONFIG" ]; then
  FACTORY_ROOT=$(CDPATH= cd -- "$FACTORY_ROOT" && pwd) || exit 9
fi
if [ -n "$FACTORY_ROOT" ] && [ -n "$FACTORY_PR_CONFIG" ] && [ "$DIRECTORY" = "$FACTORY_ROOT/deploy/orch" ]; then
  if [ "$1" = browser-suite ]; then
    shift
    exec node "$FACTORY_ROOT/bin/browser-suite.mjs" "$FACTORY_PR_CONFIG" "$@"
  fi
  exec node "$FACTORY_ROOT/bin/pr-delivery.mjs" "$FACTORY_PR_CONFIG" "$@"
fi
echo 'missing installation receipt; reinstall delivered factory source' >&2
exit 9
