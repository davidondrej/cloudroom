#!/bin/bash
# One Apple check per macOS release. release-gui.yml runs this after the app and its DMG are built and signed.
# Apple's ticket for a DMG also covers the app inside it, so only the DMG is uploaded. The app then gets its
# copy of that ticket, and the update ZIP is built from the stapled app.
# Safe to rerun: a DMG that already has its ticket is not sent again.
# Needs VERSION, plus APPLE_ID, APPLE_TEAM_ID, and APPLE_APP_SPECIFIC_PASSWORD for the upload.
set -euo pipefail
cd "$(dirname "$0")/.."

out=release.noindex
dmg="$out/Cloudroom-v$VERSION-arm64.dmg"
app="$out/mac-arm64/Cloudroom.app"
# Outside the work folder: a mount left behind there would break the next run's checkout.
work=$(cd "$(mktemp -d)" && pwd -P)
cleanup() {
  node -e 'import("./scripts/macos-bundle.mjs").then((bundle) => bundle.unregisterBundle(process.argv[1]))' "$work" || true
  hdiutil detach "$work/dmg" > /dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

xcrun stapler validate "$dmg" > /dev/null 2>&1 || node scripts/notarize.cjs "$dmg"
# Only the upload needs Apple's login, and the build wrapper below rejects a partial set of signing keys.
unset APPLE_ID APPLE_TEAM_ID APPLE_APP_SPECIFIC_PASSWORD

mkdir "$work/dmg"
hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$work/dmg" > /dev/null
# A reused build has only its saved DMG, which holds the same signed app.
[ -d "$app" ] || { mkdir -p "$(dirname "$app")" && ditto "$work/dmg/Cloudroom.app" "$app"; }
# Apple can take a moment to list the app's ticket after it approves the DMG.
for attempt in 1 2 3 4 5; do
  xcrun stapler staple "$app" && break
  echo "No ticket for the app yet. Retrying in 30 s ($attempt/5)."
  sleep 30
done
xcrun stapler validate "$app"

echo "v$VERSION" > .cloudroom-version
CSC_IDENTITY_AUTO_DISCOVERY=false BB_CLOUDROOM_STAMP=1 node scripts/run-electron-builder.mjs --mac zip --arm64 --publish never --prepackaged "$app"

# Gatekeeper must accept all three things users get: the DMG, the app they drag out of it, and the app in the update ZIP.
spctl -a -vvv -t open --context context:primary-signature "$dmg"
spctl -a -vvv -t exec "$work/dmg/Cloudroom.app"
ditto -x -k "$out/Cloudroom-v$VERSION-arm64.zip" "$work/zip"
xcrun stapler validate "$work/zip/Cloudroom.app"
spctl -a -vvv -t exec "$work/zip/Cloudroom.app"
