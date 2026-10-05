#!/bin/sh
set -eu
: "${FACTORY_CHECKOUT:?bind the verified software-factory checkout}"
: "${FACTORY_NIGHTLY_STATE:?bind the persistent factory-only diagnosis directory}"
exec node "$FACTORY_CHECKOUT/scripts/nightly-watch.mjs" "$FACTORY_NIGHTLY_STATE"
