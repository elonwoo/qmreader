#!/usr/bin/env bash
# Build a double-clickable QMReader.app from a clean checkout.
#
# - runs npm ci for the webfront and the bundled runtime
# - copies the local Node binary into src-tauri/binaries (Tauri externalBin)
# - stages server.js / lib / scripts / public / native / node_modules into
#   src-tauri/runtime (Tauri bundle resources)
# - builds with Tauri and ad-hoc signs the result
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RUNTIME_DIR="$ROOT/src-tauri/runtime"
APP_PATH="$ROOT/src-tauri/target/release/bundle/macos/QMReader.app"
PURIFY_COPY="$ROOT/public/purify.min.js"

cleanup() {
  # public/ must stay pristine for upstream merges: purify.min.js is only a
  # build-time copy served from the Tauri asset bundle.
  rm -f "$PURIFY_COPY"
}
trap cleanup EXIT

echo "==> [1/6] npm ci"
npm ci

NODE_BIN="${QMREADER_NODE_BIN:-$(command -v node)}"
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "Node executable not found. Set QMREADER_NODE_BIN." >&2
  exit 1
fi
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".").map(Number)[0]')"
NODE_MINOR="$("$NODE_BIN" -p 'process.versions.node.split(".").map(Number)[1]')"
NODE_PATCH="$("$NODE_BIN" -p 'process.versions.node.split(".").map(Number)[2]')"
if (( NODE_MAJOR < 22 || (NODE_MAJOR == 22 && NODE_MINOR < 22) )); then
  echo "Node >= 22.22 is required (node:sqlite). Found $("$NODE_BIN" -v)." >&2
  exit 1
fi
echo "    Node: $NODE_BIN ($("$NODE_BIN" -v))"

echo "==> [2/6] stage external Node binary"
HOST_TRIPLE="$(rustc -vV | awk '/^host:/{print $2}')"
if [[ -z "$HOST_TRIPLE" ]]; then
  echo "Could not determine Rust host triple." >&2
  exit 1
fi
mkdir -p "$ROOT/src-tauri/binaries"
cp "$NODE_BIN" "$ROOT/src-tauri/binaries/node-$HOST_TRIPLE"
chmod +x "$ROOT/src-tauri/binaries/node-$HOST_TRIPLE"

echo "==> [3/6] stage runtime resources"
rm -rf "$RUNTIME_DIR"
mkdir -p "$RUNTIME_DIR"
cp "$ROOT/server.js" "$ROOT/package.json" "$ROOT/package-lock.json" "$RUNTIME_DIR/"
cp -R \
  "$ROOT/lib" \
  "$ROOT/scripts" \
  "$ROOT/public" \
  "$ROOT/native" \
  "$ROOT/.rss-reliability" \
  "$RUNTIME_DIR/"

echo "==> [4/6] install production dependencies for runtime"
npm ci --omit=dev --prefix "$RUNTIME_DIR" --no-audit --no-fund

echo "==> [5/6] Tauri build (ad-hoc signed app bundle)"
cp "$ROOT/node_modules/dompurify/dist/purify.min.js" "$PURIFY_COPY"
npx tauri build --bundles app

echo "==> [6/6] sign nested Node runtime and verify bundle"
if [[ ! -d "$APP_PATH" ]]; then
  echo "Build finished but $APP_PATH is missing." >&2
  exit 1
fi
# Tauri re-signs external binaries with `codesign -s -` but drops the
# entitlements the official Node binary ships with. V8 then fails with
# "Failed to reserve virtual memory for CodeRange" under the hardened runtime.
# Re-sign Node with its JIT entitlements, then re-seal the app around it.
codesign --force --sign - --options runtime \
  --entitlements "$ROOT/src-tauri/node.entitlements" \
  "$APP_PATH/Contents/MacOS/node"
codesign --force --sign - --options runtime \
  --entitlements "$ROOT/src-tauri/app.entitlements" \
  "$APP_PATH"
codesign --verify --deep --strict --verbose=1 "$APP_PATH"

echo
echo "Built: $APP_PATH"
echo "Open:  open \"$APP_PATH\""
