#!/bin/sh
set -eu
: "${FACTORY:?set FACTORY to the pinned software-factory checkout}"
: "${FACTORY_DELIVERY_CONFIG:?set the shared private delivery config}"
exec node "$FACTORY/bin/pr-delivery.mjs" "$FACTORY_DELIVERY_CONFIG" merge-one-core "$@"
