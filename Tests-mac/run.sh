#!/bin/bash
# Compiles Notemaker/Core/*.swift + Tests-mac/main.swift into a CLI and runs it.
#   Tests-mac/run.sh                 run all tests
#   Tests-mac/run.sh --import f.json print a summary of any v2 (or v1) backup file
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/tools/swiftc-env.sh"
OUT="$NM_BUILD/tests/notemaker-tests"
mkdir -p "$(dirname "$OUT")"
echo "Compiling tests…" >&2
nm_swiftc -O "$ROOT"/Notemaker/Core/*.swift "$ROOT/Tests-mac/main.swift" -o "$OUT" >&2
cd "$ROOT"
if [ "$1" = "--import" ] || [ "$1" = "--migrate-v1-defaults" ]; then exec "$OUT" "$@"; fi
exec "$OUT" --root "$ROOT" "$@"
