# TV connector

Lets Claude (claude.ai on the web, Desktop and mobile) control the TV PC: run
commands, start long downloads in the background, read and write files, and
check update status. It's a remote MCP server with its own sign-in, published
to the internet by [Tailscale Funnel](https://tailscale.com/kb/1223/funnel).

It's one Python file using only the standard library, so it runs on plain
Bazzite with nothing extra installed. The whole download is about 55 KB. For
now it runs from your home folder; it moves into the tv-os image later.

## Install (at the TV, in Konsole)

You need a free [Tailscale](https://tailscale.com) account. Bazzite already
includes Tailscale.

```sh
curl -fsSLO https://raw.githubusercontent.com/skeddles/tv-os/main/connector/install.sh
bash install.sh
```

The script:

1. Downloads `tv-connector.py` to `~/.local/share/tv-connector/`.
2. Starts Tailscale and, if this PC isn't signed in yet, shows a **QR code**.
   Scan it with your phone and sign in. It asks for your password once.
3. Saves the settings and prints a **pairing code** like `ASUY-7G8W-67QA`.
   You type it once when Claude connects. It works once, within 7 days.
4. Runs the connector as a background service that starts at boot.
5. Publishes it with Funnel. The first time, Tailscale may print a link to turn
   Funnel on for your tailnet: open it, approve, and the script continues.

Then, on any device:

1. claude.ai → **Settings → Connectors → Add custom connector**.
2. Name `TV PC`, URL `https://<your-tv>.<your-tailnet>.ts.net/mcp` (the script
   prints the exact address).
3. **Connect**. A page from your TV opens. Type the pairing code and **Approve**.

Running `bash install.sh` again updates the connector and keeps your pairing code.

## What Claude can and can't do

| Tool | What it does |
|---|---|
| `run_command` | Runs a shell command as your user (up to 15 minutes) |
| `start_background_job` | Starts a long command as a systemd user unit; keeps going if the chat ends |
| `job_status` / `stop_job` | Lists jobs, shows their state and recent log lines, stops one |
| `read_file` / `write_file` | Reads and writes text files |
| `system_status` | OS deployments and update progress, Wi-Fi signal and rate, disk space, running jobs |

Everything runs as **your normal user**. `sudo` fails because it needs your
password. By default that includes OS updates: Bazzite lets someone sitting at
the TV run `rpm-ostree upgrade`/`rebase` without a password, but not a
background service.

**Optional:** to let Claude start OS updates and the switch to the custom image
remotely, run this once:

```sh
bash ~/.local/share/tv-connector/install.sh --allow-os-updates
```

It adds a polkit rule that lets only your user run `rpm-ostree` refresh,
upgrade, rebase, deploy, rollback and cancel without a password. Choosing which
OS image boots is effectively full control of the PC, so only turn this on if
you're comfortable with Claude having that. Undo it with `--disallow-os-updates`.

## Seeing what Claude does

Every tool call (with its command or file path) is logged:

```sh
journalctl --user -u tv-connector -f
```

## Security

- The server listens only on the TV itself (127.0.0.1:8765). Funnel is the only
  way in from outside.
- Claude's requests (`/mcp`, `/token`, `/register`) are accepted only from
  Anthropic's published outbound range, `160.79.104.0/21`
  ([source](https://platform.claude.com/docs/en/api/ip-addresses)). Funnel
  replaces `X-Forwarded-For` with the caller's real address, so it can't be
  faked from outside.
- Sign-in follows Claude's connector requirements
  ([source](https://claude.com/docs/connectors/building/authentication)):
  OAuth 2.1 with PKCE (S256) and Dynamic Client Registration. The only accepted
  redirect is `https://claude.ai/api/mcp/auth_callback`.
- Anthropic's range is shared by every claude.ai account, so the address alone
  doesn't prove it's *your* Claude. That's what the pairing code is for, and
  why it **works once** and expires after 7 days. To connect Claude again (a
  new device, or after `revoke`), make a new code at the TV with `new-code`.
- **Only approve a sign-in you started yourself.** If anyone sends you a
  "reconnect your TV" link, deny it: approving would give their Claude account
  control of your TV. The approval page says this too.
- Wrong codes: a sign-in page closes after 3, and after 8 in 15 minutes all
  sign-ins lock for 15 minutes. Attempts are counted before checking, so
  parallel guesses can't get around the limit.
- Access tokens last 1 hour. Refresh tokens are replaced every time they're
  used and expire after 30 days unused. If an old one is ever reused, that
  connection is signed out. Tokens and the pairing code are stored only as
  hashes, in files only your account can read.
- One request per connection, no chunked uploads, 30-second timeouts and capped
  registrations, so a misbehaving caller can't confuse or tie up the server or
  push your own connection out.

Trade-offs to know about:

- `install.sh` downloads the latest `tv-connector.py` from this repo's `main`
  branch without a checksum, so whoever controls the GitHub account controls
  what an install or update runs.
- Signing in to Tailscale with `--operator=$USER` lets programs running as your
  user change Tailscale settings, including Funnel, without sudo.
- `--uninstall` turns off Funnel on port 443 entirely, which is fine as long as
  nothing else on the TV uses Funnel.

## Commands

```sh
S=~/.local/share/tv-connector/tv-connector.py
python3 $S status       # address, connected sessions
python3 $S new-code     # a fresh one-time pairing code (to connect Claude again)
python3 $S revoke       # sign Claude out everywhere (reconnect needs the code)
systemctl --user restart tv-connector
bash ~/.local/share/tv-connector/install.sh --uninstall
```

## Not yet verified on the real TV

- Background jobs and their logs through `systemd-run --user`. The options were
  checked against Bazzite's systemd 259, but a container here couldn't boot
  systemd.
- Claude's sign-in through a live Funnel address. The whole OAuth flow is
  covered by `test_connector.py`, but not against claude.ai itself.

## Development

```sh
python3 connector/test_connector.py   # 29 end-to-end tests, no network needed
```
