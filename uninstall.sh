#!/usr/bin/env bash
# Removes the global `enclo` symlink npm link created. Does NOT touch
# ~/.enclo/ (your config + tokens) — delete that by hand if you want.
set -euo pipefail

err()  { printf '\033[31m[enclo-cli]\033[0m %s\n' "$*" >&2; }
info() { printf '\033[32m[enclo-cli]\033[0m %s\n' "$*"; }

if ! command -v npm >/dev/null 2>&1; then
  err "npm is not on PATH — nothing to do."
  exit 1
fi

info "Unlinking the 'enclo' global..."
if npm unlink -g enclo 2>/dev/null; then
  info "Done. The 'enclo' command should be gone from your PATH."
else
  info "'enclo' was not globally linked. Nothing to remove."
fi

info ""
info "To also wipe per-user config and saved tokens:"
info "  rm -rf ~/.enclo"
