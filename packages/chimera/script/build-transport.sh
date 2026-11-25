#!/usr/bin/env bash
#
# Build the native HTTP transport (chimera-transport) and stage the .node
# where the TS loader (packages/chimera/src/provider/sdk/native-transport/
# loader.ts) finds it for from-source runs and tests:
#
#   chimera-transport/prebuilds/<platform>-<arch>[-musl]/chimera-transport.node
#
# The transport is OPTIONAL everywhere: when the .node is absent the provider
# seam keeps Bun fetch. This script needs a Rust toolchain (rustup.rs).
#
# Usage:
#   packages/chimera/script/build-transport.sh                 # host platform
#   packages/chimera/script/build-transport.sh --target <rust-triple> [--platform <plat-arch>] [--zig]
#   packages/chimera/script/build-transport.sh --target <triple-1> --target <triple-2> ...
#
# Cross-compile notes:
# - --zig builds through `cargo zigbuild` (zig as the C compiler + linker
#   backend; needs zig and cargo-zigbuild installed). Required when the host
#   cannot natively link the target: any linux leg from macOS, musl legs, and
#   cross-arch gnu legs.
# - Linux gnu targets accept cargo-zigbuild's glibc-VERSIONED form
#   (x86_64-unknown-linux-gnu.2.28), which caps the GLIBC symbol versions the
#   .node requires so artifacts built on new runners still dlopen on older
#   distros. A versioned target implies --zig (only zigbuild parses it), and a
#   plain gnu target under --zig is auto-pinned to the release floor
#   (TRANSPORT_GLIBC_FLOOR, default 2.28 = the manylinux_2_28 generation floor).
#   musl legs opt out of musl's default +crt-static (rustc refuses cdylib under
#   a static CRT) and link dynamically against musl libc — the napi/alpine
#   convention; no glibc-style floor concern.
# - macOS legs pin MACOSX_DEPLOYMENT_TARGET (default 11.0) so artifacts do not
#   inherit the BUILD machine's macOS version as their load floor.
# - Windows: cargo emits chimera_transport.dll; the staged name is always
#   chimera-transport.node (Node/Bun dlopen on Windows loads the renamed DLL —
#   the napi/node-gyp convention). Release legs are *-pc-windows-msvc,
#   CI-native on windows runners (napi-build links MSVC legs with no extra
#   inputs); there is no supported local cross route, so windows targets on a
#   non-Windows host fail loudly (same as the macOS-only legs). windows-gnu
#   triples map too, but napi-build's gnu setup additionally requires a
#   libnode.dll import library on LIBNODE_PATH/LIBPATH/PATH, so they are not
#   buildable here.
#
# Adapted from packages/chimera/script/build-kernel.sh; only the pieces this
# crate needs are kept (no kernel-specific CI/grammar handling).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CRATE="$ROOT/chimera-transport"

GLIBC_FLOOR="${TRANSPORT_GLIBC_FLOOR:-2.28}"
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-11.0}"

TARGETS=()
PLATFORM=""
ZIG=0
while [ $# -gt 0 ]; do
  case "$1" in
    --target)   TARGETS+=("$2"); shift 2 ;;
    --platform) PLATFORM="$2"; shift 2 ;;
    --zig)      ZIG=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done
if [ "${#TARGETS[@]}" -gt 1 ] && [ -n "$PLATFORM" ]; then
  echo "--platform only applies to a single --target build" >&2
  exit 1
fi

# Map a rust triple to the bundle-target naming used across the release
# pipeline (darwin-arm64, linux-x64, linux-x64-musl, ...). Must stay in sync
# with kernelPrebuildPlatformDir (packages/chimera/script/package-variant.ts),
# which copyTransportPrebuild reuses for this crate. The dir spelling matches
# the loader's `${process.platform}-${process.arch}` repo-prebuild candidate.
platform_for() {
  case "$1" in
    aarch64-apple-darwin)       echo "darwin-arm64" ;;
    x86_64-apple-darwin)        echo "darwin-x64" ;;
    x86_64-unknown-linux-gnu)   echo "linux-x64" ;;
    aarch64-unknown-linux-gnu)  echo "linux-arm64" ;;
    x86_64-unknown-linux-musl)  echo "linux-x64-musl" ;;
    aarch64-unknown-linux-musl) echo "linux-arm64-musl" ;;
    x86_64-pc-windows-msvc|x86_64-pc-windows-gnu)   echo "win32-x64" ;;
    aarch64-pc-windows-msvc|aarch64-pc-windows-gnu) echo "win32-arm64" ;;
    *) return 1 ;;
  esac
}

host_platform() {
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64)  echo "darwin-arm64" ;;
    Darwin-x86_64) echo "darwin-x64" ;;
    Linux-x86_64)  echo "linux-x64" ;;
    Linux-aarch64) echo "linux-arm64" ;;
    MINGW*-x86_64|MSYS*-x86_64)   echo "win32-x64" ;;
    MINGW*-aarch64|MSYS*-aarch64) echo "win32-arm64" ;;
    *) return 1 ;;
  esac
}

# Build one leg and stage its .node. $1 = rust triple ("" = host build),
# $2 = platform name. Runs with cwd = $CRATE.
build_leg() {
  local target="$1" platform="$2" outdir lib
  local zig="$ZIG"
  if [ -n "$target" ]; then
    # Versioned glibc targets (…-gnu.2.28) are zigbuild-only syntax.
    case "$target" in *.*) zig=1 ;; esac
    # Targets the host toolchain cannot link natively route through zigbuild;
    # targets no local route can link fail loudly (release CI builds them on
    # native runners — see the transport-prebuild matrix in publish.yml).
    local host_os
    case "$(uname -s)" in
      Darwin) host_os=darwin ;;
      Linux)  host_os=linux ;;
      MINGW*|MSYS*|CYGWIN*) host_os=windows ;;
      *) host_os=other ;;
    esac
    case "$target" in
      *-unknown-linux-*) [ "$host_os" = linux ] || zig=1 ;;
      *-pc-windows-*)    [ "$host_os" = windows ] || { echo "[transport] error: $target needs a Windows host (CI-native MSVC legs only; no local cross route)" >&2; exit 1; } ;;
      *-apple-darwin)    [ "$host_os" = darwin ] || { echo "[transport] error: $target needs a macOS host (no local cross route)" >&2; exit 1; } ;;
    esac
    # Auto-pin the release glibc floor for plain gnu targets under zig, so a
    # forgotten explicit pin cannot ship an artifact bound to the runner's
    # own (newest) glibc.
    if [ "$zig" = "1" ]; then
      case "$target" in *-unknown-linux-gnu) target="$target.$GLIBC_FLOOR" ;; esac
    fi
    local base="${target%%.*}"
    if [ "$zig" = "1" ]; then
      command -v zig >/dev/null 2>&1 || { echo "[transport] error: zig not installed (brew install zig)" >&2; exit 1; }
      command -v cargo-zigbuild >/dev/null 2>&1 || { echo "[transport] error: cargo-zigbuild not installed (cargo install cargo-zigbuild)" >&2; exit 1; }
      echo "[transport] building chimera-transport for ${platform} (target ${target}, zig)"
    else
      echo "[transport] building chimera-transport for ${platform} (target ${target})"
    fi
    rustup target add "$base" >/dev/null 2>&1 || true
    # musl targets default to +crt-static and rustc refuses cdylib output
    # under a static CRT — opt out so the .node links dynamically against
    # musl libc (the napi/alpine convention). The flag goes through
    # CARGO_ENCODED_RUSTFLAGS, not RUSTFLAGS: cargo-zigbuild composes its own
    # encoded flags and cargo's precedence order would let those mask a plain
    # RUSTFLAGS env. Scoped to this leg so multi-target runs do not leak it.
    local saved_encoded_rustflags="${CARGO_ENCODED_RUSTFLAGS-}"
    case "$target" in
      *-musl*) export CARGO_ENCODED_RUSTFLAGS="${saved_encoded_rustflags:+$saved_encoded_rustflags$(printf '\037')}-C$(printf '\037')target-feature=-crt-static" ;;
    esac
    if [ "$zig" = "1" ]; then
      cargo zigbuild --release --target "$target"
    else
      cargo build --release --target "$target"
    fi
    if [ -n "$saved_encoded_rustflags" ]; then
      export CARGO_ENCODED_RUSTFLAGS="$saved_encoded_rustflags"
    else
      unset CARGO_ENCODED_RUSTFLAGS
    fi
    outdir="$CRATE/target/$base/release"
  else
    echo "[transport] building chimera-transport for ${platform} (host toolchain)"
    cargo build --release
    outdir="$CRATE/target/release"
  fi

  # cdylib name differs per OS; the staged name is always chimera-transport.node.
  case "$platform" in
    darwin-*) lib="$outdir/libchimera_transport.dylib" ;;
    linux-*)  lib="$outdir/libchimera_transport.so" ;;
    win32-*)  lib="$outdir/chimera_transport.dll" ;;
    *) echo "[transport] error: cannot derive library name for platform '$platform'" >&2; exit 1 ;;
  esac
  [ -f "$lib" ] || { echo "[transport] error: built library not found at $lib" >&2; exit 1; }

  local dest="$CRATE/prebuilds/$platform"
  mkdir -p "$dest"
  # rm first so the copy lands on a FRESH inode: overwriting a signed dylib in
  # place leaves macOS's per-inode signature cache stale, and every process
  # that then dlopens the staged .node is SIGKILLed at load.
  rm -f "$dest/chimera-transport.node"
  cp "$lib" "$dest/chimera-transport.node"
  echo "[transport] staged $dest/chimera-transport.node ($(du -h "$dest/chimera-transport.node" | cut -f1))"
}

cd "$CRATE"
if [ "${#TARGETS[@]}" -eq 0 ]; then
  if [ -z "$PLATFORM" ]; then
    if ! PLATFORM="$(host_platform)"; then
      echo "unrecognized host $(uname -s)-$(uname -m); pass --target or --platform" >&2
      exit 1
    fi
  fi
  build_leg "" "$PLATFORM"
else
  for leg in "${TARGETS[@]}"; do
    leg_platform="$PLATFORM"
    if [ -z "$leg_platform" ]; then
      if ! leg_platform="$(platform_for "${leg%%.*}")"; then
        echo "cannot map rust target '$leg' to a platform name; pass --platform" >&2
        exit 1
      fi
    fi
    build_leg "$leg" "$leg_platform"
  done
fi