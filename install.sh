#!/usr/bin/env bash
# enclo CLI installer — works in two layouts:
#
#   (A) Inside a CLI-only monorepo (after running scripts/prepare-cli-repo.sh
#       on the source repo, OR cloned from the published enclo-cli GitHub
#       repo). Layout:
#           ./
#             package.json   (workspaces: enclo-code, enclo-core)
#             enclo-code/
#             enclo-core/
#             install.sh     <-- this file lives at the repo root
#       In this layout install.sh is run from the repo root.
#
#   (B) Inside the original monorepo, where install.sh lives at
#       enclo-code/install.sh and the workspace package.json is one level
#       up. We `cd ..` to find it. Layout:
#           ./
#             package.json   (workspaces: enclo-code, enclo-core, enclo-vscode)
#             enclo-code/
#               install.sh   <-- this file
#             enclo-core/
#
# Either way the script ends with `enclo` on PATH.

set -euo pipefail

err()  { printf '\033[31m[enclo-cli]\033[0m %s\n' "$*" >&2; }
info() { printf '\033[32m[enclo-cli]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[enclo-cli]\033[0m %s\n' "$*"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Detect layout. Layout A: this script's dir contains a package.json with
# workspaces. Layout B: the parent dir does.
if [ -f "${SCRIPT_DIR}/package.json" ] && grep -q '"workspaces"' "${SCRIPT_DIR}/package.json" 2>/dev/null; then
  WORKSPACE_ROOT="${SCRIPT_DIR}"
  ENCLO_CODE_DIR="${SCRIPT_DIR}/enclo-code"
elif [ -f "${SCRIPT_DIR}/../package.json" ] && grep -q '"workspaces"' "${SCRIPT_DIR}/../package.json" 2>/dev/null; then
  WORKSPACE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
  ENCLO_CODE_DIR="${SCRIPT_DIR}"
else
  err "Could not find a workspace package.json above or at ${SCRIPT_DIR}."
  err "Expected one of:"
  err "  - ${SCRIPT_DIR}/package.json with a workspaces array (CLI-only repo)"
  err "  - ${SCRIPT_DIR}/../package.json with a workspaces array (monorepo)"
  exit 1
fi

cd "${WORKSPACE_ROOT}"

# 1. Node 20+ check
if ! command -v node >/dev/null 2>&1; then
  err "Node.js is not installed."
  err "Install Node 20+ from https://nodejs.org or via Homebrew:"
  err "  brew install node@20 && brew link --overwrite node@20"
  exit 1
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "${NODE_MAJOR}" -lt 20 ]; then
  err "Node ${NODE_MAJOR} is too old — enclo needs Node 20+."
  err "Upgrade: https://nodejs.org or 'brew install node@20'"
  exit 1
fi

# 2. npm present?
if ! command -v npm >/dev/null 2>&1; then
  err "npm is not on PATH (it usually ships with Node)."
  err "Reinstall Node 20+ from https://nodejs.org"
  exit 1
fi

info "Node $(node --version) detected at $(command -v node)"

# 3. Install workspace deps
info "Installing workspace dependencies (this can take a minute)..."
npm install

# 4. Build core, then code
info "Building @enclo/core..."
npm -w @enclo/core run build

info "Building enclo-code..."
npm -w enclo-code run build

# 5. npm link from enclo-code/ so the `enclo` binary lands on PATH
info "Linking the 'enclo' binary onto your PATH..."
(
  cd "${ENCLO_CODE_DIR}"
  npm link
)

# Verify
if ! command -v enclo >/dev/null 2>&1; then
  warn "'enclo' is built but not yet on PATH."
  warn "If you used a Node version manager (nvm/volta/asdf), make sure your"
  warn "shell init loads it before checking the PATH. Try opening a new"
  warn "terminal, or run 'hash -r' in this shell."
fi

info ""
info "Done. Run 'enclo' from any terminal."
info ""
info "First run will prompt for the API URL."
info "  - Backend on this machine:    http://localhost:8000"
info "  - Backend on a LAN server:    http://<server-ip>:8000"
info ""
info "Then /signup (or /signin) inside the TUI."
