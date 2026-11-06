#!/bin/sh
# run-e2e.sh — thin wrapper around scripts/e2e-remote.mjs.
#
# Boots an ISOLATED DeepSeek Harness web Host (never the live ~/.dsh desktop
# profile), loads this plugin through a generated --patch overlay, calls the
# real `session.create` Remote RPC over HTTP, and asserts the resulting
# Workspace/directory on disk. No LLM tokens are spent.
#
#   ./scripts/run-e2e.sh                 # default: isolated home, bare create
#   ./scripts/run-e2e.sh --mode workspace
#   ./scripts/run-e2e.sh --mode cwd --expect created
#   ./scripts/run-e2e.sh --keep          # leave the Host up; rerun with --attach <url>
#   ./scripts/run-e2e.sh --verbose       # stream the Host log
#
# Every argument is forwarded to e2e-remote.mjs (--help lists them all).
# Environment overrides:
#   DSH_CLI            dsh launcher   (default: the shipped app CLI)
#   DSH_E2E_HOME       isolated DSH_HOME (default: <workspace>/.e2e/home)
#   DSH_E2E_PROFILE    profile name   (default: ws-e2e)
#   DSH_E2E_PORT       listen port    (default: 0 = OS picks a free one)
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
plugin_root=$(CDPATH= cd -- "$here/.." && pwd -P)
workspace=$(CDPATH= cd -- "$plugin_root/.." && pwd -P)

DSH_CLI="${DSH_CLI:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}"
DSH_E2E_HOME="${DSH_E2E_HOME:-$workspace/.e2e/home}"

if [ ! -x "$DSH_CLI" ]; then
  echo "run-e2e: dsh launcher not found or not executable: $DSH_CLI" >&2
  echo "         set DSH_CLI to the DeepSeek Harness CLI and try again." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "run-e2e: node is not on PATH (Node >= 20 is required for fetch/ESM)." >&2
  exit 1
fi

echo "run-e2e: plugin   $plugin_root"
echo "run-e2e: DSH_HOME $DSH_E2E_HOME"
echo "run-e2e: dsh      $DSH_CLI"
echo

DSH_CLI="$DSH_CLI" DSH_E2E_HOME="$DSH_E2E_HOME" exec node "$here/e2e-remote.mjs" "$@"
