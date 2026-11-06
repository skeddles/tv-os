# Working on the TV (rules for Claude sessions)

The TV is the owner's living-room PC, often in use. You reach it through the
"TV PC" connector (tv_screen, tv_screenshot, tv_open, tv_press, run_command...).
The owner is not a Linux expert: give step-by-step instructions, ask before
anything that can't be undone.

## Before touching the TV

- Check `tv_screen` (or `tv_screenshot`) first. If someone is watching or
  playing, ask before opening, closing or restarting anything.
- Ask before taking over the screen for tests, and say roughly how long.

## Start and stop apps only through the launcher

- Open apps and games with `tv_open` (or by sending the launcher a launch), and
  close them with `tv_close_app` / the launcher. Never start an app, game or
  Steam window directly from `run_command` (`steam steam://...`, `flatpak run`,
  `retroarch`...).
- Why: the launcher only stops reading the controller when it knows an app is
  in front. An app you start behind its back gets the controller *and* the
  launcher, hidden underneath, acts on the same presses. This happened on
  Nov 4 2026: Big Picture was opened by hand, the owner pressed buttons in it,
  and the launcher behind it started Mario Kart.
- If a test truly needs a direct start, tell the owner not to touch the
  controller until you've closed it, and close it yourself afterwards.

## Never do

- Never restart the Cage session or the display manager: on this TV's
  HDMI adapter (LSPCON) that can leave a black screen until a reboot.
- To restart the launcher, only kill Electron:
  `pkill -9 -f "^/usr/lib/tvlauncher/electron/electron"` (the session loop
  starts it again), and only after checking the screen.
- Don't use loose `pkill -f`/`pgrep -f` patterns in `run_command`: they match
  the command's own shell and kill it. Anchor patterns, or find PIDs with
  `ps ... | awk '/pattern/ && !/awk/'`.
- Never put secrets in these repos. TMDB keys live only on the TV in
  `~/.config/tvlauncher/tmdb.json` (chmod 600); write secrets with the
  connector's `write_file`, not inside `run_command` (commands are logged).

## Steam and games: things learned

- Steam settings files (`localconfig.vdf` etc.) can be restored by Steam from
  its synced copy after you edit them. Change per-game Steam settings in
  Steam's own UI (game Properties) instead, and check they stuck.
- Changing the screen scale (`wlr-randr --output DP-3 --scale N`) is safe (not
  a mode change), but the shell owns it: if you change it by hand, put it back
  (`display.apply` / the App size setting) when done.
- Steam's desktop window needs a mouse; prompts in it are invisible to the
  controller and block later game starts. The shell starts games with Big
  Picture open for this reason (shell/lib/steamui.cjs).
- Steam runs in the background, so its "Guide button focuses Steam" setting
  must stay off (Steam > Settings > Controller > Show Advanced Settings; saved
  as "Controller_CheckGuideButton" "0" in localconfig.vdf). When on, the Xbox
  button in other apps (Plex) opened Big Picture (Nov 5 2026).
- Back up any game or Steam file before editing it, to
  `~/.local/share/tvlauncher-backups/<what>-<date>/`, and tell the owner where.

## Where things are

- Plan and handoff notes: https://claude.ai/artifact/JsFPLKqX6BPTFTi85X12Ft
  (its "Status and handoff" section). UI design:
  https://claude.ai/code/artifact/d6dce887-4f56-43f4-bcbe-8d70d73251a6
- This repo: the system image, the Electron shell (`shell/`), the Claude
  connector (`connector/`). Shell changes reach the TV only with a system
  update (Settings > System update), built by CI from `main`.
- skeddles/tv-launcher-ui: the launcher screens; pushes to `main` go live on
  the TV after CI (no update needed).
