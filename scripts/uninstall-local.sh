#!/bin/sh
# Remove dsh-session-workspace from a DeepSeek Harness profile.
#
#   ./scripts/uninstall-local.sh [profile]
set -eu

profile="${1:-${DSH_PROFILE:-desktop}}"
dsh="${DSH_CLI:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}"
home="${DSH_HOME:-$HOME/.dsh}"
manifest="$home/profiles/$profile/package.json"

if [ ! -f "$manifest" ]; then
  echo "profile '$profile' not found at $home/profiles/$profile" >&2
  exit 1
fi

node - "$manifest" <<'EOF'
const { readFileSync, writeFileSync } = require('node:fs')
const file = process.argv[2]
const manifest = JSON.parse(readFileSync(file, 'utf8'))
const bundles = manifest.dsh?.profile?.bundles
if (Array.isArray(bundles)) manifest.dsh.profile.bundles = bundles.filter((name) => name !== 'dsh-session-workspace')
writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
console.log('bundle entry removed from', file)
EOF

"$dsh" plugin --profile "$profile" remove dsh-session-workspace || true
echo "Uninstalled. Restart DeepSeek Harness to unmount the plugin."
echo "Workspaces and directories it created are never deleted by this script."
