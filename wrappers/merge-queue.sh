#!/bin/sh
# Install this maintained entry point only after the factory delivery cutover.
set -eu
: "${FACTORY:?set FACTORY to the pinned software-factory checkout}"
: "${FACTORY_DELIVERY_CONFIG:?set the shared private delivery config}"
repo=${1:?usage: merge-queue.sh owner/repository}
case "$repo" in */*) ;; *) repo="jbookout/$repo" ;; esac
exec node "$FACTORY/bin/pr-delivery.mjs" "$FACTORY_DELIVERY_CONFIG" merge-queue "$repo"
