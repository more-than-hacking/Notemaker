#!/bin/bash
# Build the Linux packages in Docker, run the bridge self-test headless (Xvfb) and screenshot the real UI.
#   platforms/tauri/docker/run-linux.sh [arm64|amd64] [OUT_DIR]
# arm64 is native on Apple Silicon; amd64 runs under emulation (slow).
# Build caches live in Docker volumes (notemaker-cargo-*, notemaker-target-*), never in the repo.
set -euo pipefail
ARCH="${1:-arm64}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
OUT="${2:-$ROOT/platforms/tauri/out/linux-$ARCH}"
IMAGE="notemaker-tauri-linux:$ARCH"
mkdir -p "$OUT"

docker build --platform "linux/$ARCH" -f "$HERE/linux.Dockerfile" -t "$IMAGE" "$HERE"

docker run --rm --platform "linux/$ARCH" \
  -v "$ROOT:/src" \
  -v "$OUT:/out" \
  -v "notemaker-cargo-$ARCH:/opt/cargo/registry" \
  -v "notemaker-target-$ARCH:/build/target" \
  -v "notemaker-node-$ARCH:/src/platforms/tauri/node_modules" \
  -e CARGO_TARGET_DIR=/build/target \
  -e APPIMAGE_EXTRACT_AND_RUN=1 \
  -e NO_STRIP=true \
  -w /src/platforms/tauri \
  "$IMAGE" bash -euo pipefail -c '
    npm ci --no-audit --no-fund
    (cd src-tauri && cargo test --release 2>&1 | tail -5)
    (cd src-tauri && cargo clippy --release --all-targets -- -D warnings 2>&1 | tail -3)
    npx tauri build --bundles deb,rpm,appimage 2>&1 | tail -15
    B=/build/target/release
    cp $B/bundle/deb/*.deb $B/bundle/rpm/*.rpm $B/bundle/appimage/*.AppImage /out/ 2>/dev/null || true
    echo "== .desktop / mime in the .deb"
    dpkg-deb -c $B/bundle/deb/*.deb | grep -E "\.desktop|mime|bin/notemaker" || true
    dpkg-deb --fsys-tarfile $B/bundle/deb/*.deb | tar -xO --wildcards "./usr/share/applications/*.desktop" || true

    echo "== bridge self-test (Xvfb)"
    set +e
    NOTEMAKER_SELFTEST_OUT=/out/selftest.txt dbus-run-session -- xvfb-run -a -s "-screen 0 1280x800x24" \
      timeout 120 $B/notemaker --bridge-selftest > /out/selftest-stdout.txt 2>&1
    CODE=$?
    set -e
    cat /out/selftest-stdout.txt | grep -vE "^bridge (←|→)" | tail -150
    echo "self-test exit code: $CODE"
    echo $CODE > /out/selftest-exit-code.txt

    echo "== screenshot of the real UI"
    export HOME=/tmp/nmhome; mkdir -p $HOME
    Xvfb :77 -screen 0 1280x800x24 >/dev/null 2>&1 &
    XV=$!
    sleep 1
    DISPLAY=:77 dbus-run-session -- bash -c "$B/notemaker --bridge-log > /out/ui-log.txt 2>&1 & APP=\$!; sleep 12; import -display :77 -window root /out/linux-ui.png; kill \$APP; wait \$APP 2>/dev/null; true"
    kill $XV || true
    ls -la /out
  '
echo "→ outputs in $OUT (self-test exit code: $(cat "$OUT/selftest-exit-code.txt" 2>/dev/null))"
