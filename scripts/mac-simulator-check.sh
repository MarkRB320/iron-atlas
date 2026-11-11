#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != Darwin ]]; then
  echo "Run this check on the Mac that will build Iron Atlas." >&2
  exit 1
fi
xcodebuild -version
node -e "if (Number(process.versions.node.split('.')[0]) < 22) throw Error('Node 22 or newer is required')"
npm ci
npm test
npm run core
./node_modules/.bin/cap sync ios
build_dir="$(mktemp -d "${TMPDIR:-/tmp}/IronAtlas-simulator.XXXXXX")"
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath "$build_dir" \
  CODE_SIGNING_ALLOWED=NO build
app="$build_dir/Build/Products/Debug-iphonesimulator/App.app"
id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Info.plist")"
[[ "$id" == 'uk.co.insomniait.ironatlas' ]]
printf 'Simulator build verified for %s\n%s\n' "$id" "$app"
