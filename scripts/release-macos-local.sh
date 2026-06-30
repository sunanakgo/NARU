#!/usr/bin/env bash
#
# Build, sign, and publish a macOS NARU release LOCALLY — no GitHub Actions
# minutes (macOS runners bill at 10×). Mirrors what release.yml does for macOS:
# Apple-codesign the .app with our self-signed cert, minisign-sign the
# .app.tar.gz updater artifact, upload everything to the GitHub release, and
# write a latest.json whose URLs are authenticated API asset URLs (so the
# in-app updater can fetch them from the private repo with the user's PAT).
#
# Prereqs:
#   - .env.release present (minisign key + Apple cert identity/password).
#   - ~/naru-signing.p12 present (the Apple cert; path overridable via
#     APPLE_CERTIFICATE_P12 in .env.release).
#   - gh authenticated.
#
# Usage (from repo root):
#   ./scripts/release-macos-local.sh            # Apple Silicon only
#   ./scripts/release-macos-local.sh --with-intel   # + Intel (x86_64) cross-build
#
# The FIRST run imports the cert into a dedicated keychain and trusts it for
# code signing — that single `sudo` is the only interactive step. Later runs
# reuse the trusted identity with no prompt.

set -euo pipefail
cd "$(dirname "$0")/.."

REPO="sunanakgo/NARU"
WITH_INTEL=false
[ "${1:-}" = "--with-intel" ] && WITH_INTEL=true

[ -f .env.release ] || { echo "ERROR: .env.release not found (run from repo root)"; exit 1; }
set -a; source .env.release; set +a
: "${TAURI_SIGNING_PRIVATE_KEY:?missing in .env.release}"
: "${APPLE_SIGNING_IDENTITY:?missing in .env.release}"
: "${APPLE_CERTIFICATE_PASSWORD:?missing in .env.release}"
P12="${APPLE_CERTIFICATE_P12:-$HOME/naru-signing.p12}"
[ -f "$P12" ] || { echo "ERROR: signing cert not found at $P12"; exit 1; }

VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"

TARGETS=(aarch64-apple-darwin)
$WITH_INTEL && TARGETS+=(x86_64-apple-darwin)
declare -A TKEY=( [aarch64-apple-darwin]=darwin-aarch64 [x86_64-apple-darwin]=darwin-x86_64 )
declare -A ARCH=( [aarch64-apple-darwin]=aarch64       [x86_64-apple-darwin]=x64 )

echo "▶ Releasing $TAG  targets: ${TARGETS[*]}"

# ── 1. Signing keychain (idempotent; one-time sudo to trust the self-signed cert)
if ! security find-identity -v -p codesigning 2>/dev/null | grep -q "$APPLE_SIGNING_IDENTITY"; then
  echo "▶ Setting up signing keychain (one-time; will ask for your password to trust the cert)…"
  KC="$HOME/Library/Keychains/naru-signing.keychain-db"
  KC_PW="$APPLE_CERTIFICATE_PASSWORD"   # reuse — this keychain only holds that cert
  CERT_PEM="$(mktemp).pem"
  openssl pkcs12 -legacy -in "$P12" -clcerts -nokeys -passin "pass:$APPLE_CERTIFICATE_PASSWORD" -out "$CERT_PEM" 2>/dev/null \
    || openssl pkcs12 -in "$P12" -clcerts -nokeys -passin "pass:$APPLE_CERTIFICATE_PASSWORD" -out "$CERT_PEM"
  security list-keychains | grep -q naru-signing || security create-keychain -p "$KC_PW" "$KC"
  security unlock-keychain -p "$KC_PW" "$KC"
  security import "$P12" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign -k "$KC" 2>/dev/null || true
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KC_PW" "$KC" >/dev/null 2>&1 || true
  security list-keychains -d user -s "$KC" $(security list-keychains -d user | sed -e 's/[" ]//g')
  sudo security add-trusted-cert -d -r trustRoot -p codeSign -k /Library/Keychains/System.keychain "$CERT_PEM"
  rm -f "$CERT_PEM"
fi
security find-identity -v -p codesigning | grep -q "$APPLE_SIGNING_IDENTITY" \
  || { echo "ERROR: '$APPLE_SIGNING_IDENTITY' is still not a valid codesigning identity"; exit 1; }
echo "✓ signing identity ready"

# ── 2. Build each target (Tauri Apple-codesigns the .app and minisign-signs
#       the .app.tar.gz updater artifact, since the env vars above are set).
for T in "${TARGETS[@]}"; do
  rustup target add "$T" >/dev/null 2>&1 || true
  echo "▶ Building $T … (this takes a while)"
  npm run tauri build -- --target "$T"
done

# ── 3. Ensure the GitHub release exists.
gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 || \
  gh release create "$TAG" --repo "$REPO" --title "NARU $TAG" \
    --notes "macOS build (locally signed). Existing installs see the in-app update button."

# ── 4. Upload bundles (arch-suffixed so arm64/x64 don't collide).
STAGE="$(mktemp -d)"
for T in "${TARGETS[@]}"; do
  B="src-tauri/target/$T/release/bundle"; AN="${ARCH[$T]}"
  cp "$B/macos/NARU.app.tar.gz"     "$STAGE/NARU_${AN}.app.tar.gz"
  cp "$B/macos/NARU.app.tar.gz.sig" "$STAGE/NARU_${AN}.app.tar.gz.sig"
  DMG="$(ls "$B"/dmg/*.dmg | head -1)"
  gh release upload "$TAG" --repo "$REPO" --clobber \
    "$STAGE/NARU_${AN}.app.tar.gz" "$STAGE/NARU_${AN}.app.tar.gz.sig" "$DMG"
done

# ── 5. Build latest.json with authenticated API asset URLs and upload it.
ASSETS="$(gh api "repos/$REPO/releases/tags/$TAG" --jq '.assets')"
PLATFORMS="{}"
for T in "${TARGETS[@]}"; do
  AN="${ARCH[$T]}"; K="${TKEY[$T]}"
  SIG="$(cat "$STAGE/NARU_${AN}.app.tar.gz.sig")"
  ID="$(echo "$ASSETS" | jq -r --arg n "NARU_${AN}.app.tar.gz" '.[]|select(.name==$n)|.id')"
  [ -n "$ID" ] && [ "$ID" != "null" ] || { echo "ERROR: uploaded asset NARU_${AN}.app.tar.gz not found"; exit 1; }
  PLATFORMS="$(echo "$PLATFORMS" | jq \
    --arg k "$K" --arg sig "$SIG" \
    --arg url "https://api.github.com/repos/$REPO/releases/assets/$ID" \
    '. + {($k): {signature:$sig, url:$url}}')"
done
jq -n --arg v "$VERSION" --arg d "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson p "$PLATFORMS" \
  '{version:$v, notes:"", pub_date:$d, platforms:$p}' > "$STAGE/latest.json"
gh release upload "$TAG" --repo "$REPO" --clobber "$STAGE/latest.json"

echo "✓ Released $TAG. latest.json:"
cat "$STAGE/latest.json"
rm -rf "$STAGE"
echo
echo "NOTE: the updater key was rotated, so your currently-installed build won't"
echo "auto-update to this one. Install this DMG manually ONCE; future updates resume."