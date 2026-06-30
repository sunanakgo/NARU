#!/usr/bin/env bash
#
# Generate a STABLE self-signed code-signing certificate for NARU's macOS
# release builds. Run this ONCE on any Mac, then store the three printed values
# as GitHub Actions repository secrets (Settings → Secrets and variables →
# Actions):
#
#   APPLE_SIGNING_IDENTITY      ← the identity name (cert Common Name)
#   APPLE_CERTIFICATE           ← base64 of the .p12 (private key + cert)
#   APPLE_CERTIFICATE_PASSWORD  ← the .p12 password
#
# release.yml feeds these to tauri-action, which imports the cert into a
# temporary keychain on the macOS runner and signs every build's .app (and the
# .app.tar.gz updater artifact) with it.
#
# WHY a stable cert matters: macOS ties a Keychain item's access-control list
# and a bundle's notification authorization to the app's code-signing
# "designated requirement", which for a self-signed cert is its leaf-cert hash.
# Ad-hoc signing produces a fresh cdhash every build, so each in-app update
# looked like a different app and silently dropped Keychain access (the Claude
# usage credentials) and notification permission. Reusing ONE cert across all
# builds keeps that requirement constant, so permissions survive updates.
#
# This is NOT Apple notarization — fresh DMG installs still hit a Gatekeeper
# warning ("unidentified developer"). It only fixes update-to-update continuity.
# Keep the generated .p12 somewhere safe; regenerating it changes the identity
# and breaks continuity for already-installed copies.
#
# Works with both the system LibreSSL (`/usr/bin/openssl`) and OpenSSL 3
# (Homebrew). Extensions go through a config file (LibreSSL lacks `-addext`),
# and the PKCS#12 export tries the `-legacy` format first — macOS `security
# import` on the runner reads that reliably — falling back when `-legacy`
# isn't supported.

set -euo pipefail

IDENTITY="${1:-NARU Self-Signed}"
OUT_DIR="${2:-$(pwd)}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

P12_PATH="$OUT_DIR/naru-signing.p12"
P12_PASSWORD="$(openssl rand -base64 24)"

# Extension config: mark the cert critical-CA:false and valid for code signing.
# The codeSigning EKU is what lets `codesign` accept this as a signing identity.
cat > "$WORKDIR/codesign.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions    = v3_codesign
prompt             = no

[dn]
CN = $IDENTITY

[v3_codesign]
basicConstraints       = critical,CA:FALSE
keyUsage               = critical,digitalSignature
extendedKeyUsage       = critical,codeSigning
subjectKeyIdentifier   = hash
EOF

# Key + self-signed cert, 10-year validity, extensions from the config above.
openssl genrsa -out "$WORKDIR/key.pem" 2048
openssl req -x509 -new -key "$WORKDIR/key.pem" -days 3650 \
  -config "$WORKDIR/codesign.cnf" -extensions v3_codesign \
  -out "$WORKDIR/cert.pem"

# Bundle key + cert into a PKCS#12 the runner imports. Prefer the legacy
# encryption format (best macOS keychain compatibility); fall back if the local
# openssl doesn't support `-legacy` (LibreSSL already writes the legacy format).
if ! openssl pkcs12 -export -legacy \
      -inkey "$WORKDIR/key.pem" -in "$WORKDIR/cert.pem" \
      -name "$IDENTITY" -out "$P12_PATH" \
      -passout "pass:$P12_PASSWORD" 2>/dev/null; then
  openssl pkcs12 -export \
    -inkey "$WORKDIR/key.pem" -in "$WORKDIR/cert.pem" \
    -name "$IDENTITY" -out "$P12_PATH" \
    -passout "pass:$P12_PASSWORD"
fi

echo "Wrote $P12_PATH"
echo
echo "=== Add these as GitHub Actions repository secrets ==="
echo
echo "APPLE_SIGNING_IDENTITY"
echo "$IDENTITY"
echo
echo "APPLE_CERTIFICATE_PASSWORD"
echo "$P12_PASSWORD"
echo
echo "APPLE_CERTIFICATE  (base64 of the .p12)"
base64 < "$P12_PATH"
