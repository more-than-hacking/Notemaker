#!/bin/bash
# Shared Swift toolchain setup for build.sh and Tests-mac/run.sh.
# Defines `nm_swiftc <args…>`, which runs swiftc with the macOS SDK and a persistent module cache.
# If the Command Line Tools' duplicate SwiftBridging module map breaks the build
# ("redefinition of module 'SwiftBridging'"), it retries with a VFS overlay that hides that file.

NM_ROOT="${NM_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
NM_BUILD="${NM_BUILD:-$NM_ROOT/build}"
NM_TARGET="${NM_TARGET:-$(uname -m)-apple-macos14}"
mkdir -p "$NM_BUILD/module-cache"

NM_SDK="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null)"
[ -z "$NM_SDK" ] && NM_SDK="/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk"

NM_BRIDGING="/Library/Developer/CommandLineTools/usr/include/swift/module.modulemap"
NM_OVERLAY_FLAGS=()
nm_make_overlay() {
  local empty="$NM_BUILD/empty.modulemap"
  : > "$empty"
  cat > "$NM_BUILD/overlay.yaml" <<YAML
{ "version": 0, "case-sensitive": "false", "roots": [ { "type": "file",
  "name": "$NM_BRIDGING",
  "external-contents": "$empty" } ] }
YAML
  NM_OVERLAY_FLAGS=(-Xcc -ivfsoverlay -Xcc "$NM_BUILD/overlay.yaml" -vfsoverlay "$NM_BUILD/overlay.yaml")
}
# Remember a previous decision so we don't pay for a failing build every time.
[ -f "$NM_BUILD/.use-overlay" ] && nm_make_overlay

nm_swiftc() {
  local log="$NM_BUILD/swiftc-last.log"
  # First attempt is captured quietly: on a fresh machine it usually hits the CLT SwiftBridging bug,
  # whose wall of errors is harmless because we retry with the workaround below.
  swiftc -swift-version 5 -sdk "$NM_SDK" -target "$NM_TARGET" -module-cache-path "$NM_BUILD/module-cache" \
    "${NM_OVERLAY_FLAGS[@]}" "$@" > "$log" 2>&1 && local rc=0 || local rc=$?   # "|| rc" keeps `set -e` callers alive
  if [ $rc -ne 0 ] && [ ${#NM_OVERLAY_FLAGS[@]} -eq 0 ] && grep -q "redefinition of module 'SwiftBridging'" "$log"; then
    echo "→ Applying the Command Line Tools SwiftBridging workaround (normal on first build; takes a few minutes)…"
    nm_make_overlay
    touch "$NM_BUILD/.use-overlay"
    swiftc -swift-version 5 -sdk "$NM_SDK" -target "$NM_TARGET" -module-cache-path "$NM_BUILD/module-cache" \
      "${NM_OVERLAY_FLAGS[@]}" "$@" 2>&1 | tee "$log"
    rc=${PIPESTATUS[0]}
  elif [ $rc -ne 0 ] || grep -qE "warning:|error:" "$log"; then
    cat "$log"
  fi
  return $rc
}
