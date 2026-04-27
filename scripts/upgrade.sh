#!/usr/bin/env bash
# Pull the latest CLI code, rebuild, and re-link.
set -euo pipefail
cd "$(dirname "$0")/.."

err()  { printf '\033[31m[enclo-cli]\033[0m %s\n' "$*" >&2; }
info() { printf '\033[32m[enclo-cli]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[enclo-cli]\033[0m %s\n' "$*"; }

# Find the workspace root (same logic as install.sh).
SCRIPT_PARENT="$(pwd)"
if [ -f "${SCRIPT_PARENT}/package.json" ] && grep -q '"workspaces"' "${SCRIPT_PARENT}/package.json" 2>/dev/null; then
  WORKSPACE_ROOT="${SCRIPT_PARENT}"
elif [ -f "${SCRIPT_PARENT}/../package.json" ] && grep -q '"workspaces"' "${SCRIPT_PARENT}/../package.json" 2>/dev/null; then
  WORKSPACE_ROOT="$(cd "${SCRIPT_PARENT}/.." && pwd)"
else
  err "Could not find the workspace root from $(pwd)."
  exit 1
fi

cd "${WORKSPACE_ROOT}"

if [ -d .git ]; then
  info "git pull..."
  git pull --ff-only
else
  warn "No .git here — skipping git pull. (Are you running from a tarball?)"
fi

info "Reinstalling dependencies..."
npm install

info "Rebuilding @enclo/core + enclo-code..."
npm -w @enclo/core run build
npm -w enclo-code run build

info "Refreshing the 'enclo' link..."
(cd "${WORKSPACE_ROOT}/enclo-code" && npm link)

info "Upgrade complete. 'enclo' is up-to-date."
