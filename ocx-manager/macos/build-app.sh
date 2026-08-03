#!/bin/bash
# Construit OCXSwitcher.app depuis le code source Swift.
set -euo pipefail

cd "$(dirname "$0")"

APP="OCXSwitcher.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

swiftc -O -o "$APP/Contents/MacOS/OCXSwitcher" OCXSwitcher/main.swift
cp OCXSwitcher/Info.plist "$APP/Contents/Info.plist"
# Icône : génère AppIcon.icns depuis le PNG RunningHub (éclair noir / fond blanc)
if [ -f OCXSwitcher/icon-codex-black.png ]; then
  TMPICONS="$(mktemp -d /tmp/ocxicons.XXXXXX)"
  cp OCXSwitcher/icon-codex-black.png "$TMPICONS/icon.png"
  mkdir -p "$TMPICONS/AppIcon.iconset"
  for s in 16 32 128 256 512; do
    sips -z "$s" "$s" "$TMPICONS/icon.png" --out "$TMPICONS/AppIcon.iconset/icon_${s}x${s}.png" >/dev/null 2>&1
    sips -z "$((s*2))" "$((s*2))" "$TMPICONS/icon.png" --out "$TMPICONS/AppIcon.iconset/icon_${s}x${s}@2x.png" >/dev/null 2>&1
  done
  iconutil -c icns "$TMPICONS/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"
elif command -v rsvg-convert >/dev/null 2>&1 && [ -f OCXSwitcher/icon-white.svg ]; then
  TMPICONS="$(mktemp -d /tmp/ocxicons.XXXXXX)"
  rsvg-convert -w 1024 -h 1024 OCXSwitcher/icon-white.svg -o "$TMPICONS/icon.png"
  mkdir -p "$TMPICONS/AppIcon.iconset"
  for s in 16 32 128 256 512; do
    sips -z "$s" "$s" "$TMPICONS/icon.png" --out "$TMPICONS/AppIcon.iconset/icon_${s}x${s}.png" >/dev/null 2>&1
    sips -z "$((s*2))" "$((s*2))" "$TMPICONS/icon.png" --out "$TMPICONS/AppIcon.iconset/icon_${s}x${s}@2x.png" >/dev/null 2>&1
  done
  iconutil -c icns "$TMPICONS/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"
else
  cp OCXSwitcher/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
fi

echo "✅ $APP construit"
echo "   Démarrage : open $APP"
