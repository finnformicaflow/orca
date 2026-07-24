#!/usr/bin/env bash
set -euo pipefail

# Orca-hosted preview dependency self-heal (referenced by orca.config's preview commands, like
# preview-db.sh). Orca gives each worktree its node_modules by CoW-cloning the MAIN checkout's tree
# (linkToWorktree) — fast, but the clone is only as fresh as main. If main is behind and a branch bumped
# a dependency (a new package, or a major like ai v6→v7 that renames an API), the cloned tree is stale
# and the backend fails to compile against it (e.g. "'instructions' does not exist" when the code wants
# ai v7 but the clone has v6). This reinstalls ONLY when the tree has drifted from package-lock.json, so
# a healthy clone still starts instantly.
#
#   preview-deps.sh <dir>   reinstall <dir>'s node_modules iff missing/partial or drifted from its lockfile
#
# Fast path is a marker file `node_modules/.orca-deps-ok`, touched after each successful install: if the
# lockfile isn't newer than it (and the tree looks intact), the install is skipped. A CoW-cloned tree
# carries the marker with main's (older) mtime, while git checks the lockfile out fresh — so a genuinely
# stale clone reinstalls once (incrementally, since the clone pre-populated most of the tree), then the
# marker's new mtime makes subsequent starts fast. `npm install` is idempotent, so a spurious reinstall
# is at worst a quick no-op, never a breakage.

DIR="${1:?Usage: $0 <dir with package.json>}"
cd "$DIR"
[ -f package.json ] || { echo "preview-deps: no package.json in $(pwd)" >&2; exit 1; }

# Prefer the lockfile as the drift signal (it changes on every dependency change); fall back to
# package.json for repos that don't commit a lockfile.
lock=package-lock.json; [ -f "$lock" ] || lock=package.json
marker=node_modules/.orca-deps-ok

# In sync: a @-scoped package resolving proves the tree isn't a half-written partial clone, the marker
# proves a prior install completed, and the lockfile not being newer than the marker proves no drift.
if [ -d node_modules ] && [ -f "$marker" ] && [ ! "$lock" -nt "$marker" ]; then
  exit 0
fi

echo "[orca] installing $(pwd) deps (node_modules missing/partial or drifted from $lock)"
# A partial CoW clone can leave npm's half-written staging dirs (e.g. .package-name-XXXX) that a fresh
# `npm install` trips over; sweep them first. Harmless when there are none.
find -E node_modules -type d -regex '.*/\.[^/]+-[A-Za-z0-9_]+$' -prune -exec rm -rf {} + 2>/dev/null || true
npm install --no-audit --no-fund
touch "$marker"
