#!/bin/bash
# Runs inside the image build. Installs the kiosk session, the launcher shell
# and the services that keep the UI live-updating.

set -ouex pipefail

### Config files, scripts, session entry and systemd units
cp -avf /ctx/system_files/. /

### Packages
# Bazzite already includes cage (the kiosk compositor), its own Xwayland and the
# libraries Electron needs (nss, gtk3, mesa-libgbm, alsa-lib...). Adding
# Fedora's Xwayland conflicts with Bazzite's, so only add what's missing:
# nodejs/npm run the launcher UI's Vite dev server; git pulls UI updates.
dnf5 install -y nodejs npm git
command -v cage

### Electron shell
install -d /usr/lib/tvlauncher
cp -a /ctx/shell-out/electron /usr/lib/tvlauncher/electron
cp -a /ctx/shell-out/app /usr/lib/tvlauncher/app
# Chromium's sandbox helper (used only if unprivileged user namespaces are off)
chown root:root /usr/lib/tvlauncher/electron/chrome-sandbox
chmod 4755 /usr/lib/tvlauncher/electron/chrome-sandbox

### Backup copy of the UI
install -d /usr/share/tvlauncher
cp -a /ctx/shell-out/ui-fallback /usr/share/tvlauncher/ui-fallback

### Scripts are executable
chmod 0755 /usr/bin/tvlauncher-*

### UI services start for every user at login (they do nothing harmful in KDE)
systemctl --global enable tvlauncher-ui-update.service tvlauncher-ui-dev.service

### Record what this image is, shown in Settings > About
echo "tv-os $(date -u +%Y-%m-%d) on $(rpm -E %fedora 2>/dev/null | sed 's/^/Fedora /')" > /usr/share/tvlauncher/image-version
