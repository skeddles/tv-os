# tv-os

The operating system for the TV PC: plain [Bazzite](https://bazzite.gg) that
boots straight into a full-screen, controller-driven launcher. There's no
desktop, taskbar or start menu.

Built from Universal Blue's [image-template](https://github.com/ublue-os/image-template).
GitHub Actions rebuilds it on every push and once a day (so Bazzite's own
fixes flow in), and publishes it to `ghcr.io/skeddles/tv-os:latest`.

The launcher's look and screens live in a separate repo,
[tv-launcher-ui](https://github.com/skeddles/tv-launcher-ui), which updates live
on the TV without rebooting.

## How it fits together

| Layer | What | Where | Updates |
|---|---|---|---|
| 1. OS image | Bazzite + everything below | this repo | daily, applied on reboot |
| 2. Kiosk session | Cage: one full-screen app at a time | `system_files/usr/bin/tvlauncher-session` | with the image |
| 3. Shell | Electron window that hosts the UI, launches apps, installs from Flathub | `shell/` | with the image |
| 4. UI | React + Vite dev server, pulled from GitHub every 5 s | tv-launcher-ui | live, no refresh |

Boot sequence: Plasma Login Manager auto-logs in to the **TV Launcher**
session → `tvlauncher-session` starts the UI services and Cage →
Cage runs `tvlauncher-shell`, which restarts the Electron shell if it ever exits
→ the shell shows `http://localhost:5173` (the live UI), or the last good
build if the dev server isn't up yet.

## Claude connector

[`connector/`](connector/README.md) lets Claude control the TV from any Claude
chat: run commands, start long downloads, read and write files, check update
status. It installs into your home folder with one small script, so it works
before you switch to this image.

## Installing on the TV PC

You need: Bazzite already installed (Phase 1), a keyboard for these few
commands, and the latest build here showing a green check under
**Actions → Build container image**.

1. Open **Konsole** from the KDE menu and switch to this image:

   ```sh
   rpm-ostree rebase ostree-unverified-registry:ghcr.io/skeddles/tv-os:latest
   ```

   It downloads for a few minutes. When it finishes, restart:

   ```sh
   systemctl reboot
   ```

2. Log in to KDE as usual (nothing looks different yet). Open Konsole again and
   turn on boot-to-launcher for your account:

   ```sh
   sudo tvlauncher-enable
   systemctl reboot
   ```

   It asks for your password once. After the restart, the TV goes straight to the
   launcher. The first boot takes a minute longer while it downloads the UI.

3. Plug in the Xbox controller. D-pad/stick moves, **A** opens, **B** goes back,
   **Y** searches. The **Xbox button** closes the app you're in and returns home.
   Shortcuts that work in any app all start with holding **View** (the small
   left button): View + D-pad up/down = volume, View + X = mouse mode on/off,
   View + Y = on-screen keyboard.

### Getting back to the KDE desktop

Press **Ctrl+Alt+F3**, log in with your username and password, then:

```sh
sudo tvlauncher-disable
systemctl reboot
```

Or, with SSH turned on (`ujust toggle-ssh`), run the same from another computer.

### If an update breaks something

Pick the previous entry on the boot menu, or run `rpm-ostree rollback` and
reboot. Updates download in the background and apply on the next restart.

## Settings you can change

Defaults are in `/usr/share/tvlauncher/config`. Override any of them in
`~/.config/tvlauncher/config`:

| Setting | Default | Meaning |
|---|---|---|
| `TVLAUNCHER_UI_REPO` | tv-launcher-ui on GitHub | Where the UI comes from |
| `TVLAUNCHER_UI_BRANCH` | `tv` | Branch the TV follows (CI moves it only for passing commits) |
| `TVLAUNCHER_UI_POLL` | `5` | Seconds between update checks |
| `TVLAUNCHER_START_STEAM` | `0` | `1` starts Steam in the background at login |

## Known hardware issue: HDMI black screen

This PC's HDMI socket goes through an LSPCON (DisplayPort-to-HDMI) converter
chip, which sometimes fails to wake up after the display is switched off and
on (warm reboot, session restart). The kernel log then shows `LSPCON resume
failed` / `LSPCON mode hasn't settled`, the TV says "no signal", and only a
cold power-off and on brings it back. It's a long-known Intel driver timing
issue on HP mini desktops
([drm/intel #165](https://gitlab.freedesktop.org/drm/intel/-/issues/165),
[fdo #107503](https://bugs.freedesktop.org/show_bug.cgi?id=107503)).

- Reliable fix: connect the TV with a **DisplayPort-to-HDMI cable** from one of
  the PC's DisplayPort sockets, which don't use the converter.
- Meanwhile: shut down and power on rather than restart, and restart only the
  launcher app (Settings → Restart launcher), never the whole session.

## Troubleshooting

All logs go to the journal. From a console or SSH:

```sh
journalctl --user -t tvlauncher-shell -f      # the Electron shell
journalctl --user -u tvlauncher-ui-update -f  # UI downloads and updates
journalctl --user -u tvlauncher-ui-dev -f     # Vite dev server
systemctl --user restart tvlauncher-ui-dev    # restart the live UI server
```

## Developing

```sh
cd shell
npm ci
npm run check     # syntax checks + smoke tests (no Electron needed)
npm start         # runs the shell against http://localhost:5173
```

Building the whole image locally: `just build`, then
`sudo bootc switch --transport containers-storage localhost/tv-os:latest` on the TV.

The UI ↔ shell contract is `window.tv`, defined in `shell/preload.cjs` and typed
in tv-launcher-ui's `src/lib/bridge.ts`.

## Image signing (optional, recommended later)

Builds aren't signed yet, which is why step 1 uses `ostree-unverified-registry`.
The image still comes over HTTPS from GitHub's registry; signing additionally
proves it was built by this repo. To turn it on, follow the image-template
guide: [creating a cosign key](https://github.com/ublue-os/image-template#step-2a-creating-a-cosign-key).
Commit `cosign.pub` and add the private key as the `SIGNING_SECRET` repository
secret. The build signs automatically once that secret exists. The image also
needs a container policy entry for `ghcr.io/skeddles/tv-os` before you can
switch with `ostree-image-signed`.

## Not yet verified on the real TV

These need testing in Phase 3:

- Which window Cage shows when Plex, Chrome or a Steam game opens on top of the
  launcher, and that the launcher comes back when they close.
- Steam games launched from the launcher inside Cage, and Steam Input.
- The Xbox button returning home from Plex or Chrome (read directly from the
  controller via `/dev/input`; `shell/lib/evdev.cjs`).
- Flathub installs from the launcher without a password prompt.
- KDE Connect remote input inside Cage.
