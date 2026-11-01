#!/usr/bin/bash
# Installs (or updates) the TV connector in your home folder, so Claude can
# control this PC before you switch to the custom tv-os image.
#
#   curl -fsSLO https://raw.githubusercontent.com/skeddles/tv-os/main/connector/install.sh
#   bash install.sh
#
# Downloads one ~40 KB file. Uses the Python 3 and Tailscale that ship with
# Bazzite; nothing else is installed. Run it again any time to update.
#
#   bash install.sh --uninstall           remove it (Funnel off, service and files gone)
#   bash install.sh --allow-os-updates    optional: let Claude run rpm-ostree upgrade/rebase
#   bash install.sh --disallow-os-updates undo that
set -euo pipefail

BASE="${TV_CONNECTOR_BASE:-https://raw.githubusercontent.com/skeddles/tv-os/main/connector}"
PORT="${TV_CONNECTOR_PORT:-8765}"
APP_DIR="$HOME/.local/share/tv-connector"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/tv-connector.service"
SERVER="$APP_DIR/tv-connector.py"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

if [ "$(id -u)" -eq 0 ]; then
    die "Run this as your normal user, not with sudo. It asks for your password when it needs it."
fi

POLKIT_RULE=/etc/polkit-1/rules.d/49-tv-connector-os-updates.rules

# Optional: let this user (and so Claude, through the connector) download and
# switch OS images without a password. By default Bazzite allows that only
# from someone sitting at the TV. Choosing which OS image boots is effectively
# full control of the PC, so this is off unless you turn it on.
if [ "${1:-}" = "--allow-os-updates" ]; then
    say "Allowing $USER to update and switch the OS image without a password"
    sudo tee "$POLKIT_RULE" >/dev/null <<EOF
// Written by tv-connector install.sh --allow-os-updates. Remove with --disallow-os-updates.
polkit.addRule(function(action, subject) {
    if (subject.user == "$USER" && [
            "org.projectatomic.rpmostree1.repo-refresh",
            "org.projectatomic.rpmostree1.upgrade",
            "org.projectatomic.rpmostree1.rebase",
            "org.projectatomic.rpmostree1.deploy",
            "org.projectatomic.rpmostree1.rollback",
            "org.projectatomic.rpmostree1.cancel"
        ].indexOf(action.id) >= 0) {
        return polkit.Result.YES;
    }
});
EOF
    sudo chmod 0644 "$POLKIT_RULE"
    echo "Done. rpm-ostree upgrade/rebase/rollback now work for $USER without sudo, including from Claude."
    echo "Undo with: bash $0 --disallow-os-updates"
    exit 0
fi
if [ "${1:-}" = "--disallow-os-updates" ]; then
    sudo rm -f "$POLKIT_RULE"
    echo "Removed. OS updates need your password again (or someone at the TV)."
    exit 0
fi

if [ "${1:-}" = "--uninstall" ]; then
    say "Removing the TV connector"
    tailscale funnel --https=443 off 2>/dev/null || sudo tailscale funnel --https=443 off 2>/dev/null || true
    systemctl --user disable --now tv-connector.service 2>/dev/null || true
    rm -f "$UNIT"
    systemctl --user daemon-reload
    rm -rf "$APP_DIR" "${XDG_CONFIG_HOME:-$HOME/.config}/tv-connector" "${XDG_STATE_HOME:-$HOME/.local/state}/tv-connector"
    echo "Done. Also remove the connector in claude.ai: Settings > Connectors."
    exit 0
fi

command -v python3 >/dev/null || die "python3 is missing (it ships with Bazzite, so this is unexpected)."
command -v tailscale >/dev/null || die "tailscale is missing. On Bazzite it should be built in; check with: rpm -q tailscale"

# ---- 1. The server file (the only download) ----
say "1/4  Downloading the connector"
mkdir -p "$APP_DIR"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$here/tv-connector.py" ] && [ -z "${TV_CONNECTOR_FORCE_DOWNLOAD:-}" ] && [ "$here" != "$APP_DIR" ]; then
    cp "$here/tv-connector.py" "$SERVER.new"
    echo "Using the copy next to this script."
else
    curl -fsSL --retry 5 --retry-delay 3 --connect-timeout 20 "$BASE/tv-connector.py" -o "$SERVER.new" \
        || die "Download failed. Check the internet connection and run this again."
fi
python3 -m py_compile "$SERVER.new" || die "The downloaded file is damaged. Run this again."
mv "$SERVER.new" "$SERVER"
chmod 0755 "$SERVER"
cp "$0" "$APP_DIR/install.sh" 2>/dev/null || true
echo "Saved $SERVER"

# ---- 2. Tailscale ----
say "2/4  Tailscale"
if ! systemctl is-active --quiet tailscaled; then
    echo "Starting Tailscale (asks for your password)…"
    sudo systemctl enable --now tailscaled
fi
ts_state() { tailscale status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("BackendState",""))' 2>/dev/null || true; }
if [ "$(ts_state)" != "Running" ]; then
    echo "Sign this PC in to Tailscale. Scan the QR code with your phone, or open the link."
    echo "(--operator lets your user manage Funnel without sudo from now on.)"
    sudo tailscale up --qr --operator="$USER"
fi
[ "$(ts_state)" = "Running" ] || die "Tailscale isn't signed in yet. Run this script again after signing in."
dns=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
[ -n "$dns" ] || die "Couldn't read this PC's Tailscale name. Is MagicDNS turned on in the Tailscale admin console?"
PUBLIC_URL="https://$dns"
echo "This PC's address: $PUBLIC_URL"

# ---- 3. Settings, pairing code and the background service ----
say "3/4  Setting up the service"
python3 "$SERVER" setup --public-url "$PUBLIC_URL" --port "$PORT"

mkdir -p "$UNIT_DIR"
cat > "$UNIT" <<EOF
[Unit]
Description=TV connector (lets Claude control this PC)

[Service]
ExecStart=/usr/bin/python3 $SERVER serve
Restart=always
RestartSec=5
# Logs: journalctl --user -u tv-connector -f

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable tv-connector.service >/dev/null
systemctl --user restart tv-connector.service
# Keep running after reboot even before anyone logs in.
loginctl enable-linger "$USER" 2>/dev/null || sudo loginctl enable-linger "$USER"

for _ in $(seq 1 20); do
    curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
    sleep 0.5
done
curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 \
    || die "The service didn't start. See: journalctl --user -u tv-connector -n 50"
echo "Service is running."

# ---- 4. Publish it with Tailscale Funnel ----
say "4/4  Publishing with Tailscale Funnel"
echo "If Funnel isn't enabled for your tailnet yet, Tailscale prints a link: open it, approve, and this continues."
tailscale funnel --bg "$PORT" 2>/dev/null || sudo tailscale funnel --bg "$PORT"

say "Done. Now add it in Claude:"
cat <<EOF

  1. Open claude.ai > Settings > Connectors > Add custom connector.
  2. Name: TV PC
     URL:  $PUBLIC_URL/mcp
  3. Click Connect. A page from your TV opens: type the pairing code above, then Approve.

  If you lose the code:  python3 $SERVER new-code
  Sign Claude out:       python3 $SERVER revoke
  Watch what Claude does: journalctl --user -u tv-connector -f
  Remove everything:     bash $APP_DIR/install.sh --uninstall
EOF
