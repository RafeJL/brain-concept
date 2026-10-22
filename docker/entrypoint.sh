#!/bin/sh
# Puts everything the brain keeps under BRAIN_DATA: the store (and beside it, clones, locks and
# hooks.log) and the temporary worktrees runs happen in. Set BRAIN_DB or TMPDIR to split them.
set -eu
data="${BRAIN_DATA:-/data}"
export BRAIN_DB="${BRAIN_DB:-$data/brain.db}"
export TMPDIR="${TMPDIR:-$data/tmp}"
mkdir -p "$(dirname "$BRAIN_DB")" "$TMPDIR"
exec "$@"
