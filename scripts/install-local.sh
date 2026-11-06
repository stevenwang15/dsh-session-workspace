#!/bin/sh
# Install dsh-session-workspace into a DeepSeek Harness profile from this checkout.
#
#   ./scripts/install-local.sh [profile]     # profile defaults to $DSH_PROFILE or desktop
#
# The profile lives under $DSH_HOME/profiles/<profile> (~/.dsh by default), which
# is outside the workspace file sandbox: run this from a shell (or approve the
# sandbox escalation) rather than from inside a confined DSH session.
set -eu

profile="${1:-${DSH_PROFILE:-desktop}}"
here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
dsh="${DSH_CLI:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}"
home="${DSH_HOME:-$HOME/.dsh}"
manifest="$home/profiles/$profile/package.json"

if [ ! -x "$dsh" ]; then
  echo "dsh CLI not found at $dsh (set DSH_CLI to the launcher)" >&2
  exit 1
fi
if [ ! -f "$manifest" ]; then
  echo "profile '$profile' not found at $home/profiles/$profile" >&2
  exit 1
fi

echo "installing $here into profile '$profile' ..."
# file: specs are content snapshots in pnpm: re-adding the same spec does NOT
# refresh an already-installed copy. Remove first so an upgrade really upgrades.
"$dsh" plugin --profile "$profile" remove dsh-session-workspace >/dev/null 2>&1 || true
"$dsh" plugin --profile "$profile" add "file:$here"

# A bundle is mounted by listing it in dsh.profile.bundles; its own
# cordis.patch.yml then inserts the plugin row.
node - "$manifest" <<'EOF'
const { readFileSync, writeFileSync } = require('node:fs')
const file = process.argv[2]
const manifest = JSON.parse(readFileSync(file, 'utf8'))
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
const bundles = (manifest.dsh.profile.bundles ??= [])
if (!bundles.includes('dsh-session-workspace')) bundles.push('dsh-session-workspace')
writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
console.log('bundle entry ready in', file)
EOF

echo
echo "Installed. Restart DeepSeek Harness (or reload the profile) to mount the plugin."
echo "Verify: open a chat, click New Session, and watch a new workspace appear under"
echo "        ${DSH_HOME:-$HOME/.dsh}/../Documents/deepseek-harness/session-workspaces/ (or your configured baseDir)."
