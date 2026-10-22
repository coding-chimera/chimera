#!/usr/bin/env bash
#
# Build the Rust host (chimera-host) and stage the executable where the H2
# runtime will look for a per-platform host binary:
#
#   chimera-host/prebuilds/<platform>/chimera-host
#
# Unlike codegraph-kernel this crate produces a plain executable, not a cdylib.
# It is also Unix-only: the transport layer binds Unix sockets through
# std::os::unix, so there is no Windows leg (is_windows rejects win32 triples
# with an explicit reason instead of mapping a leg that cannot build).
#
# Usage:
#   packages/chimera/script/build-host.sh                 # host platform
#   packages/chimera/script/build-host.sh --target <rust-triple> [--platform <plat-arch>] [--zig]
#   packages/chimera/script/build-host.sh --target <triple-1> --target <triple-2> ...
#
# Cross-compile notes:
# - --zig builds through `cargo zigbuild` (zig as the C compiler + linker
#   backend; needs zig and cargo-zigbuild installed). Required when the host
#   cannot natively link the target: any linux leg from macOS, musl legs, and
#   cross-arch gnu legs. The release CI (publish.yml host-prebuild job) uses it
#   for all four linux legs.
# - Linux gnu targets accept cargo-zigbuild's glibc-VERSIONED form
#   (x86_64-unknown-linux-gnu.2.28), which caps the GLIBC symbol versions the
#   executable requires so artifacts built on new runners still run on older
#   distros. A versioned target implies --zig (only zigbuild parses it), and a
#   plain gnu target under --zig is auto-pinned to the release floor
#   (HOST_GLIBC_FLOOR, default 2.28).
# - musl legs deliberately KEEP rustc's default +crt-static. build-kernel.sh
#   has to opt out of it because rustc refuses cdylib output under a static CRT;
#   here the artifact is a plain executable, and the fully static musl binary is
#   exactly what we want (no libc.so needed on the target). This is the one
#   intentional divergence from the kernel script — do not "fix" it.
# - macOS legs pin MACOSX_DEPLOYMENT_TARGET (default 11.0) so artifacts do not
#   inherit the BUILD machine's macOS version as their load floor.
#
# Ported from packages/chimera/script/build-kernel.sh; only the crate, the
# staged artifact name, and the musl/Windows handling differ.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CRATE="$ROOT/chimera-host"

GLIBC_FLOOR="${HOST_GLIBC_FLOOR:-2.28}"
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
# pipeline (darwin-arm64, linux-x64, linux-x64-musl, ...). Only the Unix
# spellings exist: chimera-host depends on std::os::unix, so win32 triples are
# rejected by is_windows instead of being mapped to a leg that cannot build.
platform_for() {
  case "$1" in
    aarch64-apple-darwin)       echo "darwin-arm64" ;;
    x86_64-apple-darwin)        echo "darwin-x64" ;;
    x86_64-unknown-linux-gnu)   echo "linux-x64" ;;
    aarch64-unknown-linux-gnu)  echo "linux-arm64" ;;
    x86_64-unknown-linux-musl)  echo "linux-x64-musl" ;;
    aarch64-unknown-linux-musl) echo "linux-arm64-musl" ;;
    *) return 1 ;;
  esac
}

host_platform() {
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64)  echo "darwin-arm64" ;;
    Darwin-x86_64) echo "darwin-x64" ;;
    Linux-x86_64)  echo "linux-x64" ;;
    Linux-aarch64) echo "linux-arm64" ;;
    *) return 1 ;;
  esac
}

# Windows is not a supported target: the crate's transport layer is built on
# std::os::unix (Unix sockets). Kept as a separate predicate so both the
# --target and --platform entry points can reject it with the same reason.
is_windows() {
  case "$1" in *-pc-windows-*|win32-*) return 0 ;; *) return 1 ;; esac
}

# Build one leg and stage its executable. $1 = rust triple ("" = host build),
# $2 = platform name. Runs with cwd = $CRATE.
build_leg() {
  local target="$1" platform="$2" outdir bin
  local zig="$ZIG"
  if is_windows "$platform" || is_windows "$target"; then
    echo "[host] error: '$platform${target:+ ($target)}' is not supported: chimera-host depends on std::os::unix (Unix-socket transport) and cannot build for Windows" >&2
    exit 1
  fi
  if [ -n "$target" ]; then
    # Versioned glibc targets (…-gnu.2.28) are zigbuild-only syntax.
    case "$target" in *.*) zig=1 ;; esac
    # Targets the host toolchain cannot link natively route through zigbuild;
    # targets no local route can link fail loudly (release CI builds them on
    # native runners — see the host-prebuild matrix in publish.yml).
    local host_os
    case "$(uname -s)" in
      Darwin) host_os=darwin ;;
      Linux)  host_os=linux ;;
      *) host_os=other ;;
    esac
    case "$target" in
      *-unknown-linux-*) [ "$host_os" = linux ] || zig=1 ;;
      *-apple-darwin)    [ "$host_os" = darwin ] || { echo "[host] error: $target needs a macOS host (CI-only leg)" >&2; exit 1; } ;;
    esac
    # Auto-pin the release glibc floor for plain gnu targets under zig, so a
    # forgotten explicit pin cannot ship an artifact bound to the runner's own
    # (newest) glibc.
    if [ "$zig" = "1" ]; then
      case "$target" in *-unknown-linux-gnu) target="$target.$GLIBC_FLOOR" ;; esac
    fi
    local base="${target%%.*}"
    if [ "$zig" = "1" ]; then
      command -v zig >/dev/null 2>&1 || { echo "[host] error: zig not installed (brew install zig)" >&2; exit 1; }
      command -v cargo-zigbuild >/dev/null 2>&1 || { echo "[host] error: cargo-zigbuild not installed (cargo install cargo-zigbuild)" >&2; exit 1; }
      echo "[host] building chimera-host for ${platform} (target ${target}, zig)"
    else
      echo "[host] building chimera-host for ${platform} (target ${target})"
    fi
    rustup target add "$base" >/dev/null 2>&1 || true
    # No CARGO_ENCODED_RUSTFLAGS / -crt-static override here on purpose: musl
    # keeps its default static CRT (see the header note). Scoped nothing, so
    # multi-target runs stay identical.
    if [ "$zig" = "1" ]; then
      cargo zigbuild --release --target "$target"
    else
      cargo build --release --target "$target"
    fi
    outdir="$CRATE/target/$base/release"
  else
    echo "[host] building chimera-host for ${platform} (host toolchain)"
    cargo build --release
    outdir="$CRATE/target/release"
  fi

  bin="$outdir/chimera-host"
  if [ ! -f "$bin" ]; then
    echo "[host] error: built executable not found at $bin" >&2
    echo "[host] note: the crate must expose a [[bin]] named chimera-host (src/bin/chimera-host.rs); without one cargo emits no executable and there is nothing to stage" >&2
    exit 1
  fi

  local dest="$CRATE/prebuilds/$platform"
  mkdir -p "$dest"
  # rm first so the copy lands on a FRESH inode: overwriting a signed Mach-O in
  # place leaves macOS's per-inode signature cache stale, and every process
  # that then execs the staged binary is SIGKILLed at load (the on-disk
  # signature still verifies, which makes it maddening to diagnose). Same
  # reason as build-kernel.sh.
  rm -f "$dest/chimera-host"
  cp "$bin" "$dest/chimera-host"
  chmod +x "$dest/chimera-host"
  echo "[host] staged $dest/chimera-host ($(du -h "$dest/chimera-host" | cut -f1))"
}

cd "$CRATE"
if [ "${#TARGETS[@]}" -eq 0 ]; then
  if [ -z "$PLATFORM" ]; then
    if ! PLATFORM="$(host_platform)"; then
      echo "chimera-host is Unix-only (std::os::unix / Unix-socket transport); unsupported host $(uname -s)-$(uname -m)" >&2
      exit 1
    fi
  fi
  build_leg "" "$PLATFORM"
else
  for leg in "${TARGETS[@]}"; do
    if is_windows "$leg"; then
      echo "[host] error: $leg is not supported: chimera-host depends on std::os::unix (Unix-socket transport) and cannot build for Windows" >&2
      exit 1
    fi
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