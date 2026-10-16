#!/usr/bin/env bash
# Install entry. Source this file to call preflight without starting setup.

MEMORY_FLOOR_KB=$((3700 * 1024))

preflight() {
  local os bytes kb
  os="$(uname -s)"
  if [[ "$os" != "Darwin" && "$os" != "Linux" ]]; then
    echo "Mybots supports macOS, Linux, and WSL. This machine reports ${os}." >&2
    return 1
  fi
  if [[ "$os" == "Darwin" ]]; then
    bytes="$(sysctl -n hw.memsize)"
    kb=$((bytes / 1024))
  else
    kb="$(awk '/MemTotal/ { print $2 }' /proc/meminfo)"
  fi
  if (( kb < MEMORY_FLOOR_KB )); then
    echo "Mybots needs at least 3700 MB of memory." >&2
    return 1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "Docker is not running. Start Docker and run bash mybots.sh again." >&2
    return 1
  fi
}

main() {
  set -euo pipefail
  local root
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  cd "$root"
  if ! preflight; then
    exit 1
  fi
  bash "$root/setup.sh"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main
fi
