#!/usr/bin/env bash
# enclo bootstrap — one-command install / upgrade for the enclo CLI.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/HamadaGabrIbrahim/enclo-code/main/bootstrap.sh | bash
#
# Environment variables:
#   ENCLO_INSTALL_DIR   target dir (default: ~/.enclo/cli)
#   ENCLO_BRANCH        git branch (default: main)
set -euo pipefail

REPO_URL="https://github.com/HamadaGabrIbrahim/enclo-code.git"
INSTALL_DIR="${ENCLO_INSTALL_DIR:-$HOME/.enclo/cli}"
BRANCH="${ENCLO_BRANCH:-main}"

prefix="[enclo]"
log()  { printf "%s %s\n" "$prefix" "$*"; }
fail() { printf "%s ERROR: %s\n" "$prefix" "$*" >&2; exit 1; }

log "enclo CLI installer"
log ""

# 1. Dependency checks
command -v git >/dev/null 2>&1 || fail "'git' not found. Install: https://git-scm.com/downloads (or 'brew install git')"
command -v node >/dev/null 2>&1 || fail "'node' not found. Install Node 20+: https://nodejs.org (or 'brew install node@20')"
command -v npm >/dev/null 2>&1 || fail "'npm' not found. It usually ships with Node.js — try reinstalling Node."

node_version="$(node --version)"
node_major="$(printf "%s" "$node_version" | sed 's/^v//' | cut -d. -f1)"
if [ "$node_major" -lt 20 ]; then
  fail "Node 20+ required, you have $node_version. Install with 'brew install node@20' or from https://nodejs.org."
fi
log "✓ git, node $node_version, npm $(npm --version)"

# 2. Clone or update
if [ -d "$INSTALL_DIR/.git" ]; then
  log "Updating existing install at $INSTALL_DIR..."
  cd "$INSTALL_DIR"
  git fetch origin "$BRANCH" --quiet
  git reset --hard "origin/$BRANCH" --quiet
  log "✓ updated to $(git rev-parse --short HEAD)"
else
  log "Cloning into $INSTALL_DIR..."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR" --quiet
  cd "$INSTALL_DIR"
  log "✓ cloned"
fi

# 3. Run the existing install.sh (workspace install + build + npm link)
log "Building and linking..."
chmod +x ./install.sh
./install.sh

# 4. Done
log ""
log "✓ Installed."
log ""
log "  Run:        enclo"
log "  Upgrade:    curl -fsSL https://raw.githubusercontent.com/HamadaGabrIbrahim/enclo-code/main/bootstrap.sh | bash"
log "  Uninstall:  cd $INSTALL_DIR && ./uninstall.sh"
log ""
log "On first run, paste your enclo-api URL (e.g. http://your-server-ip:8000), then /signup."
