#!/bin/sh
exec "$(dirname "$0")/factory-entry.sh" merge-queue "$@"
