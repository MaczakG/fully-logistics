#!/usr/bin/env bash
# Builds the desktop app for one platform and packs it as a file a user can download and start:
#   Windows  FullyWms-windows-x64.zip        (FullyWms\FullyWms.exe, one file with .NET in it)
#   Linux    FullyWms-linux-x64.tar.gz       (FullyWms/FullyWms, executable bit kept)
#   macOS    FullyWms-macos-arm64.zip, -x64  (Fully WMS.app, ad-hoc signed; built on a Mac)
#
#   build/package-desktop.sh <rid> <output dir> [version]
#   e.g. build/package-desktop.sh linux-x64 out 1.0.42
# Run from native/. macOS packages need a Mac (codesign, iconutil, ditto): Apple Silicon does not
# start unsigned code, and the ad-hoc signature is enough for a downloaded app (right click > Open).
set -euo pipefail

RID=${1:?rid: win-x64, linux-x64, osx-arm64 or osx-x64}
OUT=$(mkdir -p "${2:?output dir}" && cd "$2" && pwd)
VERSION=${3:-1.0.0}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

publish() {
  dotnet publish src/Fully.Wms.Desktop -c Release -r "$RID" --self-contained -p:Version="$VERSION" -o "$WORK/app" "$@"
}

case "$RID" in
  win-x64)
    publish -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true
    mkdir -p "$WORK/FullyWms" && cp "$WORK/app/FullyWms.exe" "$WORK/FullyWms/"
    (cd "$WORK" && zip -qr "$OUT/FullyWms-windows-x64.zip" FullyWms)
    ;;
  linux-x64)
    publish -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true
    mkdir -p "$WORK/FullyWms" && cp "$WORK/app/FullyWms" "$WORK/FullyWms/" && chmod +x "$WORK/FullyWms/FullyWms"
    tar -C "$WORK" -czf "$OUT/FullyWms-linux-x64.tar.gz" FullyWms
    ;;
  osx-arm64 | osx-x64)
    # A normal (not single-file) publish inside the bundle: every file gets signed.
    publish
    APP="$WORK/Fully WMS.app"
    mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
    cp -R "$WORK/app/." "$APP/Contents/MacOS/"
    ICONSET="$WORK/FullyWms.iconset"
    mkdir -p "$ICONSET"
    for s in 16 32 128 256 512; do
      sips -z $s $s src/Fully.Wms.iOS/Assets.xcassets/AppIcon.appiconset/icon-1024.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
      sips -z $((s * 2)) $((s * 2)) src/Fully.Wms.iOS/Assets.xcassets/AppIcon.appiconset/icon-1024.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
    done
    iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/FullyWms.icns"
    cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Fully WMS</string>
  <key>CFBundleDisplayName</key><string>Fully WMS</string>
  <key>CFBundleIdentifier</key><string>hu.fully.wms</string>
  <key>CFBundleExecutable</key><string>FullyWms</string>
  <key>CFBundleIconFile</key><string>FullyWms</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleDevelopmentRegion</key><string>hu</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
PLIST
    chmod +x "$APP/Contents/MacOS/FullyWms"
    codesign --force --deep --sign - "$APP"
    codesign --verify --deep --strict "$APP"
    NAME=${RID/osx/macos}
    (cd "$WORK" && ditto -c -k --sequesterRsrc --keepParent "Fully WMS.app" "$OUT/FullyWms-$NAME.zip")
    ;;
  *)
    echo "Ismeretlen platform: $RID" >&2
    exit 2
    ;;
esac
ls -l "$OUT"
