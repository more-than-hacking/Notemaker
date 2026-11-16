#!/bin/bash
# Type-check + clippy the Windows code paths (Windows Hello, WTS/power lock, idle) from Linux/macOS, in Docker.
# Nothing is linked or run: the real build and self-test happen on windows-latest in CI.
#   platforms/tauri/docker/check-windows.sh [arm64|amd64]
set -euo pipefail
ARCH="${1:-arm64}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
IMAGE="notemaker-tauri-linux:$ARCH"
docker build --platform "linux/$ARCH" -f "$HERE/linux.Dockerfile" -t "$IMAGE" "$HERE" >/dev/null
docker run --rm --platform "linux/$ARCH" \
  -v "$ROOT:/src" \
  -v "notemaker-cargo-$ARCH:/opt/cargo/registry" \
  -v "notemaker-target-$ARCH:/build/target" \
  -e CARGO_TARGET_DIR=/build/target \
  -w /src/platforms/tauri/src-tauri \
  "$IMAGE" bash -euo pipefail -c '
    rustup target add x86_64-pc-windows-msvc >/dev/null
    command -v clang >/dev/null || (apt-get update -qq && apt-get install -y -qq --no-install-recommends clang >/dev/null)
    # llvm-rc + clang (preprocessor) for the Windows resource that tauri-build embeds
    export PATH="/usr/lib/llvm-18/bin:$PATH" CC_x86_64_pc_windows_msvc=clang
    node ../scripts/prepare-web.mjs >/dev/null
    cargo clippy --target x86_64-pc-windows-msvc --all-targets -- -D warnings
  '
