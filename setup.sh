#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

NODE_VERSION="v24.21.0"

if [[ "$(node -v 2>/dev/null || true)" == "$NODE_VERSION" ]]; then
  NODE="$(command -v node)"
else
  os="$(uname -s)"
  arch="$(uname -m)"
  case "${os}-${arch}" in
    Darwin-arm64) archive="node-${NODE_VERSION}-darwin-arm64" ;;
    Darwin-x86_64) archive="node-${NODE_VERSION}-darwin-x64" ;;
    Linux-x86_64) archive="node-${NODE_VERSION}-linux-x64" ;;
    Linux-aarch64) archive="node-${NODE_VERSION}-linux-arm64" ;;
    *)
      echo "No Node.js ${NODE_VERSION} build is published for ${os} ${arch}." >&2
      exit 1
      ;;
  esac
  mkdir -p .tools
  tmp="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${archive}.tar.gz" | tar -xz -C "$tmp"
  rm -rf .tools/node
  mv "$tmp/${archive}" .tools/node
  rm -rf "$tmp"
  NODE="$ROOT/.tools/node/bin/node"
fi

export PATH="$(dirname "$NODE"):$PATH"
npm ci
"$NODE" --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(":memory:"); db.close();'
npm run setup:auto
