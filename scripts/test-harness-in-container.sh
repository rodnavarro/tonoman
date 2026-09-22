#!/bin/sh
# The harness tests that really drop privileges need Linux, root and setpriv: `canDrop()`
# (src/harness/launch.ts) is false anywhere else, and vitest SKIPS those blocks in silence. On
# Windows that reads as a green run while the whole boundary went untested, which is how ~50
# assertions came to be written and never once executed.
#
# This runs them where canDrop() is true: a throwaway container from the dev worker image. The
# checkout is mounted read-only and copied to a writable /work, because the host's node_modules are
# Windows binaries (@esbuild/win32-x64) and vitest needs the Linux ones — so /work gets its own
# `npm ci`. Nothing is written back to the checkout.
#
#   npm run test:harness              # the whole harness suite
#   npm run test:harness -- launch    # one file, by vitest's usual filter
set -eu

IMAGE="${TONOMAN_DEV_IMAGE:-localhost/tonoman-dev-worker:local}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${TONOMAN_HARNESS_OUT:-$SRC/artifacts/harness}"
mkdir -p "$OUT"

# podman on Windows wants the Windows spelling of a host path; cygpath is there under Git Bash.
winp() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

podman image exists "$IMAGE" || {
  echo "test:harness: no image $IMAGE — bring the dev stack up once (tools/dev-stack/dev-stack.sh in tonoman-cloud)" >&2
  exit 1
}

exec podman run --rm --name tonoman-harness-tests \
  -v "$(winp "$SRC"):/src:ro" \
  -v "$(winp "$OUT"):/out" \
  -e CI=1 \
  "$IMAGE" \
  sh -c '
    set -eu
    mkdir -p /work
    for e in /src/*; do
      case "$e" in */node_modules|*/.git|*/artifacts) continue;; esac
      cp -a "$e" /work/
    done
    cd /work
    npm ci --no-audit --no-fund >/tmp/npm-ci.log 2>&1 || { tail -20 /tmp/npm-ci.log; exit 1; }
    # Proof, in the run itself, that the privilege-dropping blocks are not being skipped.
    [ "$(id -u)" = 0 ] || { echo "not root in the container: the blocks would skip" >&2; exit 1; }
    command -v setpriv >/dev/null || { echo "no setpriv: the blocks would skip" >&2; exit 1; }
    npx vitest run src/harness "$@" \
      --reporter=default \
      --reporter=json --outputFile=/out/harness.json
  ' sh "$@"
