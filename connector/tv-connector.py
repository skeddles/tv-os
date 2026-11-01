#!/usr/bin/env python3
"""TV connector: lets Claude (claude.ai, Desktop, mobile) control this PC.

A remote MCP server with its own small OAuth sign-in, published to the
internet through Tailscale Funnel. Python standard library only, so it runs on
plain Bazzite with nothing extra to download.

Security model
  * Listens on 127.0.0.1 only. The outside world reaches it through Funnel,
    which replaces X-Forwarded-For with the real caller's address.
  * /mcp, /token and /register answer only Anthropic's published outbound
    range (160.79.104.0/21). The sign-in page (/authorize) is opened from your
    own browser, so it is open but protected by a pairing code with lockout.
  * Sign-in: OAuth 2.1 authorization code + PKCE (S256), Dynamic Client
    Registration, redirect only to https://claude.ai/api/mcp/auth_callback.
    Access tokens last 1 hour; refresh tokens rotate and expire after 30 days
    unused. Codes and tokens are stored hashed.
  * Runs as your user. Anything that needs sudo still needs your password.
  * Every tool call is logged to the journal: journalctl --user -u tv-connector

Commands
  tv-connector.py serve              run the server (the systemd unit does this)
  tv-connector.py setup --public-url https://NAME.TAILNET.ts.net
  tv-connector.py new-code           make a new pairing code
  tv-connector.py revoke             sign Claude out everywhere
  tv-connector.py status             show settings and connected clients
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import html
import ipaddress
import json
import os
import re
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "0.2.0"

HOME = Path.home()
CONFIG_DIR = Path(os.environ.get("XDG_CONFIG_HOME", HOME / ".config")) / "tv-connector"
STATE_DIR = Path(os.environ.get("XDG_STATE_HOME", HOME / ".local/state")) / "tv-connector"
CONFIG_FILE = CONFIG_DIR / "config.json"
STATE_FILE = STATE_DIR / "state.json"

DEFAULT_PORT = 8765
ANTHROPIC_NETWORKS = ["160.79.104.0/21"]  # https://platform.claude.com/docs/en/api/ip-addresses
ALLOWED_REDIRECTS = {"https://claude.ai/api/mcp/auth_callback"}
SCOPE = "tv"
PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"]

ACCESS_TTL = 3600
REFRESH_TTL = 30 * 24 * 3600
AUTH_CODE_TTL = 300
PENDING_TTL = 900
MAX_CLIENTS = 50
MAX_BODY = 4 * 1024 * 1024
LOCKOUT_FAILURES = 8
LOCKOUT_WINDOW = 15 * 60
FAILURES_PER_REQUEST = 3
CODE_TTL = 7 * 24 * 3600  # a pairing code works once, within 7 days
MAX_PENDING = 100
MAX_REGISTRATIONS_PER_HOUR = 20
REFRESH_REUSE_GRACE = 60  # a retried refresh within this window isn't treated as theft

CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no 0/O, 1/I/L
JOB_PREFIX = "tvjob-"
JOB_LOG_DIR = STATE_DIR / "jobs"
MAX_JOBS = 30


def log(*parts: object) -> None:
    print(time.strftime("%Y-%m-%d %H:%M:%S"), *parts, flush=True)


def safe(value: object, limit: int = 500) -> str:
    """Escape control characters so logged values can't fake journal lines."""
    text = str(value)[:limit]
    return text.encode("unicode_escape", errors="backslashreplace").decode("ascii")


def release(failures: list[int], slot: int) -> None:
    try:
        failures.remove(slot)
    except ValueError:  # already pruned
        pass


def now() -> int:
    return int(time.time())


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


# --------------------------------------------------------------------------
# Config and state (JSON files, 0600)
# --------------------------------------------------------------------------


def write_json_private(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=1)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def read_json(path: Path) -> dict:
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def load_config() -> dict:
    cfg = read_json(CONFIG_FILE)
    cfg.setdefault("port", DEFAULT_PORT)
    cfg.setdefault("allowed_networks", ANTHROPIC_NETWORKS)
    return cfg


def normalize_code(code: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", code.upper())


def hash_code(code: str, salt: bytes) -> str:
    return hashlib.pbkdf2_hmac("sha256", normalize_code(code).encode(), salt, 200_000).hex()


def make_pairing_code() -> str:
    raw = "".join(secrets.choice(CODE_ALPHABET) for _ in range(12))
    return f"{raw[0:4]}-{raw[4:8]}-{raw[8:12]}"


class Store:
    """Clients, pending sign-ins, auth codes and tokens. Thread-safe."""

    def __init__(self, path: Path = STATE_FILE):
        self.path = path
        self.lock = threading.Lock()
        data = read_json(path)
        self.clients: dict = data.get("clients", {})
        self.access: dict = data.get("access", {})
        self.refresh: dict = data.get("refresh", {})
        self.jobs: dict = data.get("jobs", {})
        self.used_refresh: dict = data.get("used_refresh", {})  # rotated-out tokens, to detect replay
        self.pending: dict = {}  # in memory only
        self.codes: dict = {}  # in memory only
        self.failures: list[int] = []
        self.registrations: list[int] = []

    def save(self) -> None:
        write_json_private(
            self.path,
            {
                "clients": self.clients,
                "access": self.access,
                "refresh": self.refresh,
                "used_refresh": self.used_refresh,
                "jobs": self.jobs,
            },
        )

    def prune(self) -> None:
        t = now()
        for table in (self.access, self.refresh, self.used_refresh, self.codes, self.pending):
            for key in [k for k, v in table.items() if v.get("exp", 0) < t]:
                del table[key]
        if len(self.pending) > MAX_PENDING:
            for key in sorted(self.pending, key=lambda k: self.pending[k]["exp"])[: len(self.pending) - MAX_PENDING]:
                del self.pending[key]
        if len(self.clients) > MAX_CLIENTS:
            # Never evict a client that is signed in, so registrations can't push the owner out.
            live = {r["client_id"] for r in self.refresh.values()}
            idle = sorted((c for c in self.clients if c not in live), key=lambda c: self.clients[c].get("created", 0))
            for cid in idle[: len(self.clients) - MAX_CLIENTS]:
                del self.clients[cid]
        self.failures = [f for f in self.failures if f > t - LOCKOUT_WINDOW]
        self.registrations = [r for r in self.registrations if r > t - 3600]

    def revoke_client(self, client_id: str) -> None:
        for table in (self.access, self.refresh):
            for key in [k for k, v in table.items() if v.get("client_id") == client_id]:
                del table[key]

    def revoke_all(self) -> None:
        with self.lock:
            self.clients.clear()
            self.access.clear()
            self.refresh.clear()
            self.used_refresh.clear()
            self.save()


# --------------------------------------------------------------------------
# Tools
# --------------------------------------------------------------------------


def clip(text: str, limit: int = 20000) -> str:
    if len(text) <= limit:
        return text
    head = limit // 10
    return text[:head] + f"\n\n… [{len(text) - limit} characters cut] …\n\n" + text[-(limit - head) :]


def run(argv: list[str], timeout: float = 15) -> tuple[int, str]:
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, errors="replace")
        return p.returncode, (p.stdout + p.stderr).strip()
    except FileNotFoundError:
        return 127, f"{argv[0]}: not installed"
    except subprocess.TimeoutExpired:
        return 124, f"{argv[0]}: timed out after {timeout}s"


def tool_run_command(args: dict, _store: Store) -> tuple[str, bool]:
    command = str(args.get("command", "")).strip()
    if not command:
        return "No command given.", True
    timeout = max(1, min(int(args.get("timeout_seconds", 120)), 900))
    cwd = os.path.expanduser(str(args.get("cwd") or "~"))
    try:
        proc = subprocess.Popen(
            ["bash", "-lc", command],
            cwd=cwd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            start_new_session=True,
        )
    except (FileNotFoundError, NotADirectoryError) as e:
        return f"Couldn't start: {e}", True
    try:
        out, _ = proc.communicate(timeout=timeout)
        timed_out = False
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        out, _ = proc.communicate()
        timed_out = True
    status = "timed out (killed)" if timed_out else f"exit code {proc.returncode}"
    hint = ""
    if timed_out:
        hint = "\nFor long-running work use start_background_job instead."
    elif "sudo:" in out and ("password" in out or "terminal is required" in out):
        hint = "\nsudo needs the owner's password, which this connector doesn't have. Ask the owner to run it at the TV."
    return f"[{status}]\n{clip(out)}{hint}", timed_out or proc.returncode != 0


def job_unit(job_id: str) -> str:
    return JOB_PREFIX + job_id


def job_log(job_id: str) -> Path:
    return JOB_LOG_DIR / f"{job_id}.log"


def tail_lines(path: Path, n: int) -> str:
    """Last n lines of a log; progress bars drawn with \\r keep only their latest state."""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 512 * 1024))
            data = f.read().decode("utf-8", errors="replace")
    except OSError:
        return "(no log yet)"
    lines = [line.rsplit("\r", 1)[-1] for line in data.split("\n")]
    if lines and lines[-1] == "":
        lines.pop()
    return "\n".join(lines[-n:])


def tool_start_job(args: dict, store: Store) -> tuple[str, bool]:
    command = str(args.get("command", "")).strip()
    if not command:
        return "No command given.", True
    name = re.sub(r"[^\w .,:/-]", "", str(args.get("name") or command))[:80]
    job_id = time.strftime("%m%d-%H%M%S-") + secrets.token_hex(2)
    JOB_LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = job_log(job_id)
    log_path.touch()
    code, out = run(
        [
            "systemd-run", "--user", "--quiet",
            f"--unit={job_unit(job_id)}",
            f"--description=TV connector job: {name}",
            "--property=RemainAfterExit=yes",
            # Output goes to a file: journald can drop the unit tag from lines
            # written by very short-lived processes, hiding them from the log.
            f"--property=StandardOutput=append:{log_path}",
            f"--property=StandardError=append:{log_path}",
            f"--working-directory={HOME}",
            "--", "bash", "-lc", command,
        ],
        timeout=20,
    )
    if code != 0:
        return f"Couldn't start the job: {out}", True
    with store.lock:
        store.jobs[job_id] = {"command": command, "name": name, "started": now()}
        for old in sorted(store.jobs, key=lambda j: store.jobs[j]["started"])[:-MAX_JOBS]:
            del store.jobs[old]
            if job_state(old)["state"] != "running":
                run(["systemctl", "--user", "reset-failed", job_unit(old)], timeout=10)
                run(["systemctl", "--user", "stop", job_unit(old)], timeout=10)
            job_log(old).unlink(missing_ok=True)
        store.save()
    return (
        f"Started job {job_id}. It keeps running if this chat ends or the connector restarts.\n"
        f"Check it with job_status (job_id={job_id}).",
        False,
    )


def job_state(job_id: str) -> dict:
    _, out = run(
        ["systemctl", "--user", "show", job_unit(job_id),
         "-p", "LoadState,ActiveState,SubState,Result,ExecMainStatus,ExecMainStartTimestamp,ExecMainExitTimestamp"],
        timeout=10,
    )
    props = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
    if props.get("LoadState") == "not-found":
        state = "gone (cleaned up; see logs)"
    elif props.get("SubState") == "running":
        state = "running"
    elif props.get("ActiveState") == "active" and props.get("SubState") == "exited":
        state = "finished" if props.get("ExecMainStatus") == "0" else f"failed (exit code {props.get('ExecMainStatus')})"
    elif props.get("ActiveState") == "failed":
        state = f"failed (exit code {props.get('ExecMainStatus')}, {props.get('Result')})"
    else:
        state = f"{props.get('ActiveState')}/{props.get('SubState')}"
    return {"state": state, **props}


def tool_job_status(args: dict, store: Store) -> tuple[str, bool]:
    job_id = str(args.get("job_id") or "").strip()
    if not job_id:
        with store.lock:
            jobs = dict(store.jobs)
        if not jobs:
            return "No jobs yet.", False
        lines = []
        for jid, meta in sorted(jobs.items(), key=lambda kv: -kv[1]["started"]):
            st = job_state(jid)["state"]
            started = time.strftime("%b %d %H:%M", time.localtime(meta["started"]))
            lines.append(f"{jid}  {st:<28} started {started}  {meta['name']}")
        return "\n".join(lines), False
    if not re.fullmatch(r"[\w-]{1,40}", job_id):
        return "Bad job id.", True
    lines_wanted = max(5, min(int(args.get("log_lines", 40)), 400))
    st = job_state(job_id)
    meta = store.jobs.get(job_id, {})
    if job_log(job_id).exists():
        logs = tail_lines(job_log(job_id), lines_wanted)
    else:  # jobs started by connector 0.1.0 logged to the journal
        _, logs = run(
            ["journalctl", "--user", "-u", job_unit(job_id), "-n", str(lines_wanted), "--no-pager", "-o", "cat"],
            timeout=15,
        )
    return (
        f"Job {job_id}: {st['state']}\nCommand: {meta.get('command', '?')}\n"
        f"Started: {st.get('ExecMainStartTimestamp', '?')}\nEnded: {st.get('ExecMainExitTimestamp') or '-'}\n"
        f"Full log: {job_log(job_id)}\n"
        f"--- last {lines_wanted} log lines ---\n{clip(logs, 15000)}",
        False,
    )


def tool_stop_job(args: dict, store: Store) -> tuple[str, bool]:
    job_id = str(args.get("job_id") or "").strip()
    if not re.fullmatch(r"[\w-]{1,40}", job_id):
        return "Bad job id.", True
    code, out = run(["systemctl", "--user", "stop", job_unit(job_id)], timeout=30)
    run(["systemctl", "--user", "reset-failed", job_unit(job_id)], timeout=10)
    return (f"Stopped job {job_id}." if code == 0 else f"Couldn't stop {job_id}: {out}"), code != 0


def resolve_path(raw: str) -> Path:
    p = Path(os.path.expanduser(raw))
    if not p.is_absolute():
        p = HOME / p
    return p


def tool_read_file(args: dict, _store: Store) -> tuple[str, bool]:
    path = resolve_path(str(args.get("path", "")))
    offset = max(0, int(args.get("offset", 0)))
    max_bytes = max(1, min(int(args.get("max_bytes", 100_000)), 1_000_000))
    try:
        size = path.stat().st_size
        with open(path, "rb") as f:
            f.seek(offset)
            data = f.read(max_bytes)
    except OSError as e:
        return f"Couldn't read {path}: {e.strerror or e}", True
    if b"\0" in data[:8192]:
        return f"{path} looks like a binary file ({size} bytes); not shown.", False
    text = data.decode("utf-8", errors="replace")
    end = offset + len(data)
    note = f"[{path}: bytes {offset}-{end} of {size}]"
    if end < size:
        note += f" — more remains; read again with offset={end}"
    return f"{note}\n{text}", False


def tool_write_file(args: dict, _store: Store) -> tuple[str, bool]:
    path = resolve_path(str(args.get("path", "")))
    content = str(args.get("content", ""))
    mode = args.get("mode", "overwrite")
    try:
        if args.get("create_dirs", True):
            path.parent.mkdir(parents=True, exist_ok=True)
        data = content.encode()
        if mode == "append":
            with open(path, "ab") as f:
                f.write(data)
        else:
            old_mode = path.stat().st_mode & 0o7777 if path.exists() else None
            fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            if old_mode is not None:
                os.chmod(tmp, old_mode)
            else:
                os.chmod(tmp, 0o644)
            os.replace(tmp, path)
    except OSError as e:
        return f"Couldn't write {path}: {e.strerror or e}", True
    return f"{'Appended' if mode == 'append' else 'Wrote'} {len(data)} bytes to {path}.", False


def tool_system_status(_args: dict, store: Store) -> tuple[str, bool]:
    parts = [f"TV connector {VERSION} on {socket.gethostname()}"]
    _, up = run(["uptime", "-p"])
    parts.append(f"Uptime: {up}")

    code, out = run(["rpm-ostree", "status", "--json"], timeout=30)
    if code == 0:
        try:
            st = json.loads(out)
            if st.get("transaction"):
                parts.append(f"rpm-ostree: BUSY with {st['transaction']}")
            else:
                parts.append("rpm-ostree: idle")
            for d in st.get("deployments", []):
                tag = "booted" if d.get("booted") else ("staged, applies on reboot" if d.get("staged") else "previous")
                ref = d.get("container-image-reference") or d.get("origin") or "?"
                parts.append(f"  [{tag}] {d.get('version', '?')}  {ref}")
        except (json.JSONDecodeError, TypeError):
            parts.append("rpm-ostree: " + out[:300])
    else:
        parts.append("rpm-ostree: " + out[:300])

    _, wifi = run(["nmcli", "-t", "-f", "IN-USE,SSID,SIGNAL,RATE,CHAN", "dev", "wifi"])
    active = [l.split(":", 1)[1] for l in wifi.splitlines() if l.startswith("*:")]
    parts.append("Wi-Fi (ssid:signal%:rate:channel): " + (active[0] if active else "not connected / no Wi-Fi"))
    _, devs = run(["nmcli", "-t", "-f", "DEVICE,TYPE,STATE", "dev"])
    parts.append("Network devices: " + ", ".join(l for l in devs.splitlines() if ":connected" in l))
    _, df = run(["df", "-h", "--output=target,size,used,avail,pcent", "/", "/var", str(HOME)])
    parts.append("Disk:\n" + df)
    with store.lock:
        running = [j for j in store.jobs]
    active_jobs = [j for j in running if job_state(j)["state"] == "running"]
    parts.append("Background jobs running: " + (", ".join(active_jobs) if active_jobs else "none"))
    return "\n".join(parts), False


# ---- remote control of the launcher (talks to the shell's control socket) ----


def control(request: dict, timeout: float = 15) -> dict:
    runtime = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    path = os.path.join(runtime, "tvlauncher", "control.sock")
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(timeout)
            s.connect(path)
            s.sendall((json.dumps(request) + "\n").encode())
            buf = b""
            while not buf.endswith(b"\n"):
                chunk = s.recv(65536)
                if not chunk:
                    break
                buf += chunk
        return json.loads(buf or b"{}")
    except (OSError, ValueError) as e:
        return {"ok": False, "error": f"the launcher isn't answering ({e}). Is the TV on the launcher session?"}


def describe_launcher(st: dict | None) -> str:
    if not st:
        return "(launcher page not loaded)"
    lines = [f"Screen: {st.get('title') or st.get('screen')}"]
    if st.get("typing") is not None:
        lines.append(f"Keyboard open, text so far: {st['typing']!r}")
    if st.get("focused"):
        lines.append(f"Highlighted: {st['focused']['label']}")
    if st.get("notice"):
        lines.append(f"Message on screen: {st['notice']}")
    for sec in st.get("sections", []):
        items = sec.get("items", [])
        if items:
            lines.append(f"[{sec.get('title') or '—'}] " + " | ".join(items))
    return "\n".join(lines)


def tool_tv_screen(_args: dict, _store: Store) -> tuple[str, bool]:
    r = control({"cmd": "status"})
    if not r.get("ok"):
        return r.get("error", "no answer"), True
    f = r["front"]
    if f["kind"] == "launcher":
        top = "The launcher is in front."
    else:
        top = f"In front: {f['label']} ({f['kind']}); mouse mode {'on' if f['mouseMode'] else 'off'}."
    if f.get("typing"):
        top += " The on-screen keyboard is open for it."
    vol = r.get("volume") or {}
    extra = f"App size {int(r['display']['scale'] * 100)}%, volume {vol.get('volume')}%{' (muted)' if vol.get('muted') else ''}."
    body = describe_launcher(r.get("launcher")) if r.get("launcherShowing") else "(launcher hidden behind the app; use tv_screenshot to see the app)"
    return f"{top}\n{extra}\n\n{body}", False


def find_wayland_display() -> str | None:
    runtime = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    try:
        names = sorted(n for n in os.listdir(runtime) if n.startswith("wayland-") and not n.endswith(".lock"))
    except OSError:
        return None
    return names[0] if names else None


def tool_tv_screenshot(args: dict, _store: Store) -> dict | tuple[str, bool]:
    scale = max(0.25, min(float(args.get("scale", 0.5)), 1.0))
    disp = find_wayland_display()
    if not disp:
        return "No Wayland display found (is the TV on the launcher session?)", True
    env = dict(os.environ, WAYLAND_DISPLAY=disp)
    try:
        p = subprocess.run(["grim", "-s", str(scale), "-t", "jpeg", "-q", "75", "-"], capture_output=True, timeout=20, env=env)
    except FileNotFoundError:
        return "grim isn't installed yet; it comes with the tv-os image update.", True
    except subprocess.TimeoutExpired:
        return "Screenshot timed out.", True
    if p.returncode != 0 or not p.stdout:
        return f"Screenshot failed: {p.stderr.decode(errors='replace').strip()[:300]}", True
    return {
        "content": [
            {"type": "image", "data": base64.b64encode(p.stdout).decode(), "mimeType": "image/jpeg"},
            {"type": "text", "text": f"TV screen at {int(scale * 100)}% size ({len(p.stdout) // 1024} KB)."},
        ],
        "isError": False,
    }


def tool_tv_press(args: dict, _store: Store) -> tuple[str, bool]:
    r = control({"cmd": "press", "button": str(args.get("button", "")), "times": int(args.get("times", 1))})
    if not r.get("ok"):
        return r.get("error", "failed"), True
    if r.get("launcher"):
        return describe_launcher(r["launcher"]), False
    f = r.get("front", {})
    return f"Pressed. In front: {f.get('label') or 'the launcher'}.", False


def tool_tv_open(args: dict, _store: Store) -> tuple[str, bool]:
    r = control({"cmd": "open", "name": str(args.get("name", ""))})
    if r.get("ok"):
        return f"Opening {r.get('title')}.", False
    if r.get("choices"):
        return "No tile matches. Available: " + ", ".join(r["choices"]), True
    return r.get("error", "failed"), True


def tool_tv_close_app(_args: dict, _store: Store) -> tuple[str, bool]:
    r = control({"cmd": "close"})
    return (r.get("note") or "Closed the app; the launcher is in front.") if r.get("ok") else r.get("error", "failed"), not r.get("ok")


def tool_tv_type(args: dict, _store: Store) -> tuple[str, bool]:
    r = control({"cmd": "type", "text": str(args.get("text", "")), "enter": bool(args.get("enter"))})
    return ("Typed." if r.get("ok") else r.get("error", "failed")), not r.get("ok")


def tool_tv_mouse_mode(args: dict, _store: Store) -> tuple[str, bool]:
    r = control({"cmd": "mouse", "on": bool(args.get("on"))})
    if not r.get("ok"):
        return r.get("error", "failed"), True
    f = r["front"]
    return f"Mouse mode {'on' if f['mouseMode'] else 'off'} for {f['label']} (remembered for that app).", False


TOOLS = {
    "run_command": {
        "fn": tool_run_command,
        "description": (
            "Run a shell command on the TV PC as the owner's user (bash -lc) and return its output. "
            "Times out after timeout_seconds (default 120, max 900). sudo will fail: it needs the owner's "
            "password. For downloads, updates or anything slower than a couple of minutes use "
            "start_background_job."
        ),
        "schema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Shell command"},
                "timeout_seconds": {"type": "integer", "minimum": 1, "maximum": 900},
                "cwd": {"type": "string", "description": "Working directory (default: home)"},
            },
            "required": ["command"],
        },
        "annotations": {"title": "Run a command", "destructiveHint": True, "openWorldHint": True},
    },
    "start_background_job": {
        "fn": tool_start_job,
        "description": (
            "Start a long-running command in the background (as a systemd user unit) and return a job id "
            "right away. Survives the chat ending and connector restarts. Use for downloads, updates and builds."
        ),
        "schema": {
            "type": "object",
            "properties": {
                "command": {"type": "string"},
                "name": {"type": "string", "description": "Short label"},
            },
            "required": ["command"],
        },
        "annotations": {"title": "Start a background job", "destructiveHint": True, "openWorldHint": True},
    },
    "job_status": {
        "fn": tool_job_status,
        "description": "Without job_id: list recent background jobs. With job_id: its state and last log lines.",
        "schema": {
            "type": "object",
            "properties": {
                "job_id": {"type": "string"},
                "log_lines": {"type": "integer", "minimum": 5, "maximum": 400},
            },
        },
        "annotations": {"title": "Check background jobs", "readOnlyHint": True},
    },
    "stop_job": {
        "fn": tool_stop_job,
        "description": "Stop a running background job.",
        "schema": {"type": "object", "properties": {"job_id": {"type": "string"}}, "required": ["job_id"]},
        "annotations": {"title": "Stop a background job", "destructiveHint": True},
    },
    "read_file": {
        "fn": tool_read_file,
        "description": "Read a text file (paths may use ~). Up to max_bytes (default 100000) from offset.",
        "schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "offset": {"type": "integer", "minimum": 0},
                "max_bytes": {"type": "integer", "minimum": 1, "maximum": 1000000},
            },
            "required": ["path"],
        },
        "annotations": {"title": "Read a file", "readOnlyHint": True},
    },
    "write_file": {
        "fn": tool_write_file,
        "description": "Write or append text to a file (paths may use ~). Overwrites atomically; creates folders.",
        "schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "content": {"type": "string"},
                "mode": {"type": "string", "enum": ["overwrite", "append"]},
                "create_dirs": {"type": "boolean"},
            },
            "required": ["path", "content"],
        },
        "annotations": {"title": "Write a file", "destructiveHint": True},
    },
    "tv_screen": {
        "fn": tool_tv_screen,
        "description": (
            "What's on the TV right now, as text: which app is in front, mouse mode, volume, and when the "
            "launcher is showing, its screen, highlighted item and every row of tiles/settings."
        ),
        "schema": {"type": "object", "properties": {}},
        "annotations": {"title": "Read the TV screen", "readOnlyHint": True},
    },
    "tv_screenshot": {
        "fn": tool_tv_screenshot,
        "description": "A picture of what the TV is showing (any app). scale 0.25-1 (default 0.5 = 960x540).",
        "schema": {"type": "object", "properties": {"scale": {"type": "number", "minimum": 0.25, "maximum": 1}}},
        "annotations": {"title": "Screenshot the TV", "readOnlyHint": True},
    },
    "tv_press": {
        "fn": tool_tv_press,
        "description": (
            "Press a controller button. In the launcher: up/down/left/right move the highlight, select = A, "
            "back = B, search = Y, home = Xbox button. In an app: arrows, select = Enter, back = Escape, "
            "x = Space, home closes the app. Returns the launcher screen after pressing."
        ),
        "schema": {
            "type": "object",
            "properties": {
                "button": {"type": "string", "enum": ["up", "down", "left", "right", "select", "back", "search", "x", "home"]},
                "times": {"type": "integer", "minimum": 1, "maximum": 20},
            },
            "required": ["button"],
        },
        "annotations": {"title": "Press a controller button", "destructiveHint": False},
    },
    "tv_open": {
        "fn": tool_tv_open,
        "description": "Open an app, game or streaming service from the launcher by its tile name (e.g. 'Plex', 'Firefox').",
        "schema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
        "annotations": {"title": "Open an app", "destructiveHint": False},
    },
    "tv_close_app": {
        "fn": tool_tv_close_app,
        "description": "Close the app in front and go back to the launcher (like a short press of the Xbox button).",
        "schema": {"type": "object", "properties": {}},
        "annotations": {"title": "Close the app", "destructiveHint": True},
    },
    "tv_type": {
        "fn": tool_tv_type,
        "description": "Type text into the app in front (or into the open on-screen keyboard). enter=true presses Enter after.",
        "schema": {
            "type": "object",
            "properties": {"text": {"type": "string"}, "enter": {"type": "boolean"}},
            "required": ["text"],
        },
        "annotations": {"title": "Type into the TV", "destructiveHint": False},
    },
    "tv_mouse_mode": {
        "fn": tool_tv_mouse_mode,
        "description": "Turn mouse mode on or off for the app in front (remembered for that app).",
        "schema": {"type": "object", "properties": {"on": {"type": "boolean"}}, "required": ["on"]},
        "annotations": {"title": "Set mouse mode", "destructiveHint": False},
    },
    "system_status": {
        "fn": tool_system_status,
        "description": (
            "Overview of the TV PC: OS deployments and whether an update/rebase is in progress (rpm-ostree), "
            "Wi-Fi signal and link rate, disk space, running background jobs."
        ),
        "schema": {"type": "object", "properties": {}},
        "annotations": {"title": "System and update status", "readOnlyHint": True},
    },
}

INSTRUCTIONS = (
    "Use tv_screen to see what the TV shows (tv_screenshot for a picture), tv_press / tv_open / tv_type / "
    "tv_close_app to operate it like the controller. "
    "This connector controls the owner's TV PC (Bazzite Linux, KDE, Intel HD 530, 12 GB RAM). "
    "Commands run as the owner's normal user; sudo needs a password you don't have, so ask the owner to run "
    "privileged commands at the TV. Put anything slow (downloads, OS updates) in start_background_job and "
    "check it with job_status. Explain what you are about to change before changing it."
)


# --------------------------------------------------------------------------
# HTTP server
# --------------------------------------------------------------------------


AUTHORIZE_PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect Claude to your TV</title>
<style>
:root {{ color-scheme: dark; }}
body {{ margin: 0; background: #111316; color: #E8EAED; font: 17px/1.5 system-ui, sans-serif;
       display: grid; place-items: center; min-height: 100vh; padding: 16px; box-sizing: border-box; }}
main {{ max-width: 460px; width: 100%; }}
h1 {{ font-size: 26px; margin: 0 0 12px; }}
p {{ color: #A9AEB6; margin: 0 0 14px; }}
strong {{ color: #E8EAED; }}
label {{ display: block; margin: 20px 0 8px; font-weight: 600; }}
input {{ width: 100%; box-sizing: border-box; font: 600 24px ui-monospace, monospace; letter-spacing: 2px;
        padding: 12px 14px; border-radius: 10px; border: 2px solid #3a404a; background: #1c1f24; color: #fff; }}
input:focus {{ outline: none; border-color: #4F8EF7; }}
.row {{ display: flex; gap: 12px; margin-top: 20px; }}
button {{ flex: 1; font: 600 18px system-ui; padding: 14px; border-radius: 10px; border: 0; cursor: pointer; }}
.ok {{ background: #4F8EF7; color: #fff; }}
.no {{ background: #23272e; color: #E8EAED; }}
.err {{ color: #ff8a8a; }}
</style></head>
<body><main>
<h1>Connect Claude to your TV</h1>
<p><strong>{client}</strong> is asking to control <strong>{host}</strong>: run commands, read and write files,
and start background jobs as your user. After you approve, you'll be sent back to <strong>{redirect_host}</strong>.</p>
<p><strong>Only approve if you clicked Connect in your own Claude account just now</strong> (this request: {when}).
If someone sent you this link, choose Deny: approving would give their Claude account control of your TV.</p>
{error}
<form method="post" action="authorize">
<input type="hidden" name="request_id" value="{request_id}">
<label for="code">Pairing code (shown on the TV when you installed the connector)</label>
<input id="code" name="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false"
       placeholder="XXXX-XXXX-XXXX" required autofocus>
<div class="row">
<button class="no" type="submit" name="action" value="deny" formnovalidate>Deny</button>
<button class="ok" type="submit" name="action" value="approve">Approve</button>
</div>
</form>
</main></body></html>
"""

MESSAGE_PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>TV connector</title>
<style>:root{{color-scheme:dark}}body{{margin:0;background:#111316;color:#E8EAED;font:18px/1.5 system-ui;
display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}}main{{max-width:460px}}</style>
</head><body><main><h1>{title}</h1><p>{message}</p></main></body></html>"""


class Handler(BaseHTTPRequestHandler):
    server_version = "tv-connector/" + VERSION
    sys_version = ""
    protocol_version = "HTTP/1.1"
    timeout = 30  # seconds; a slow client can't hold a thread forever

    # set on the server object
    @property
    def app(self) -> "App":
        return self.server.app  # type: ignore[attr-defined]

    def log_request(self, code: object = "-", size: object = "-") -> None:
        # Path only: query strings can carry OAuth parameters.
        log(f"{self.client_ip()} {self.command} {self.path.split('?')[0]} {code}")

    def log_message(self, fmt: str, *args: object) -> None:
        log(f"{self.client_ip()} http: " + (fmt % args))

    # ---- helpers ----

    def client_ip(self) -> str:
        peer = self.client_address[0]
        try:
            loopback = ipaddress.ip_address(peer).is_loopback
        except ValueError:
            loopback = False
        fwd = self.headers.get("X-Forwarded-For")
        # Tailscale serve/funnel *sets* X-Forwarded-For to the real source address.
        # Only trust it from a loopback peer (the server never listens elsewhere).
        if loopback and fwd:
            return fwd.split(",")[-1].strip()
        return "local" if loopback else peer

    def from_allowed_network(self) -> bool:
        ip = self.client_ip()
        if ip == "local":
            return bool(self.app.config.get("allow_local"))
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            return False
        return any(addr in net for net in self.app.networks)

    def send(self, status: int, body: bytes = b"", ctype: str = "application/json", headers: dict | None = None) -> None:
        self.send_response(status)
        # One request per connection. Keep-alive gains nothing on loopback and
        # reusing connections behind a proxy invites request-smuggling bugs.
        self.close_connection = True
        self.send_header("Connection", "close")
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, status: int, obj: object, headers: dict | None = None) -> None:
        self.send(status, json.dumps(obj).encode(), "application/json", headers)

    def send_html(self, status: int, page: str) -> None:
        self.send(
            status,
            page.encode(),
            "text/html; charset=utf-8",
            {
                "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; "
                "form-action 'self' https://claude.ai; frame-ancestors 'none'; base-uri 'none'",
                "Referrer-Policy": "no-referrer",
            },
        )

    def message(self, status: int, title: str, msg: str) -> None:
        self.send_html(status, MESSAGE_PAGE.format(title=html.escape(title), message=html.escape(msg)))

    def read_body(self) -> bytes | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BODY:
            self.send_json(413, {"error": "request too large"})
            return None
        return self.rfile.read(length) if length else b""

    def forbidden(self) -> None:
        log(f"blocked {self.client_ip()} {self.command} {self.path.split('?')[0]} (not from Anthropic's range)")
        self.send_json(403, {"error": "forbidden"})

    # ---- routing ----

    def do_GET(self) -> None:
        self.route("GET")

    def do_HEAD(self) -> None:
        self.route("GET")

    def do_POST(self) -> None:
        self.route("POST")

    def do_DELETE(self) -> None:
        self.route("DELETE")

    def do_OPTIONS(self) -> None:
        self.send(204, b"", "text/plain", {"Allow": "GET, POST"})

    def route(self, method: str) -> None:
        path = urllib.parse.urlsplit(self.path).path
        if self.headers.get("Transfer-Encoding") or len(self.headers.get_all("Content-Length") or []) > 1:
            return self.send_json(501, {"error": "send a single Content-Length; chunked bodies aren't supported"})
        try:
            if path.startswith("/.well-known/oauth-protected-resource"):
                return self.send_json(200, self.app.resource_metadata())
            if path == "/.well-known/oauth-authorization-server":
                return self.send_json(200, self.app.as_metadata())
            if path == "/authorize":
                return self.authorize_get() if method == "GET" else self.authorize_post()
            if path == "/health" and method == "GET":
                return self.send_json(200, {"ok": True, "version": VERSION})
            if path in ("/register", "/token", "/mcp"):
                if not self.from_allowed_network():
                    return self.forbidden()
                if path == "/register" and method == "POST":
                    return self.register()
                if path == "/token" and method == "POST":
                    return self.token()
                if path == "/mcp":
                    return self.mcp(method)
                return self.send_json(405, {"error": "method not allowed"})
            self.send_json(404, {"error": "not found"})
        except BrokenPipeError:
            pass
        except Exception as e:  # never leak a traceback to the network
            log("error handling", method, path, repr(e))
            try:
                self.send_json(500, {"error": "server_error"})
            except Exception:
                pass

    # ---- OAuth ----

    def register(self) -> None:
        body = self.read_body()
        if body is None:
            return
        try:
            meta = json.loads(body or b"{}")
            assert isinstance(meta, dict)
        except (json.JSONDecodeError, AssertionError):
            return self.send_json(400, {"error": "invalid_client_metadata"})
        redirects = meta.get("redirect_uris") or []
        if not redirects or not all(isinstance(r, str) and r in ALLOWED_REDIRECTS for r in redirects):
            return self.send_json(
                400,
                {"error": "invalid_redirect_uri", "error_description": "only Claude's callback URL is accepted"},
            )
        client_id = "tvc_" + secrets.token_urlsafe(18)
        name = re.sub(r"[^\w .()-]", "", str(meta.get("client_name") or "Claude"))[:60] or "Claude"
        record = {"redirect_uris": redirects, "name": name, "created": now()}
        with self.app.store.lock:
            self.app.store.prune()
            if len(self.app.store.registrations) >= MAX_REGISTRATIONS_PER_HOUR:
                return self.send_json(429, {"error": "too many registrations; try again later"})
            self.app.store.registrations.append(now())
            self.app.store.clients[client_id] = record
            self.app.store.save()
        log(f"registered client {client_id} ({safe(name)})")
        self.send_json(
            201,
            {
                "client_id": client_id,
                "client_id_issued_at": record["created"],
                "client_name": name,
                "redirect_uris": redirects,
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "token_endpoint_auth_method": "none",
                "scope": SCOPE,
            },
        )

    def authorize_get(self) -> None:
        q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(self.path).query))
        store = self.app.store
        client = store.clients.get(q.get("client_id", ""))
        redirect = q.get("redirect_uri", "")
        if not client:
            return self.message(400, "Unknown app", "This sign-in link isn't from a registered Claude connection. Start again from Claude.")
        if redirect not in client["redirect_uris"]:
            return self.message(400, "Bad sign-in link", "The return address doesn't match. Start again from Claude.")

        def fail(err: str) -> None:
            params = {"error": err, "iss": self.app.issuer}
            if q.get("state"):
                params["state"] = q["state"]
            self.send(302, b"", "text/plain", {"Location": redirect + "?" + urllib.parse.urlencode(params)})

        if q.get("response_type") != "code":
            return fail("unsupported_response_type")
        if q.get("code_challenge_method") != "S256" or not re.fullmatch(r"[A-Za-z0-9_-]{43,128}", q.get("code_challenge", "")):
            return fail("invalid_request")
        resource = q.get("resource")
        if resource and resource.rstrip("/") not in self.app.resources:
            return fail("invalid_target")

        request_id = secrets.token_urlsafe(24)
        with store.lock:
            store.prune()
            store.pending[request_id] = {
                "client_id": q["client_id"],
                "redirect_uri": redirect,
                "code_challenge": q["code_challenge"],
                "state": q.get("state"),
                "resource": resource,
                "created": now(),
                "fails": 0,
                "exp": now() + PENDING_TTL,
            }
        self.render_authorize(request_id, client["name"], redirect, created=now())

    def render_authorize(self, request_id: str, client_name: str, redirect: str, error: str = "", created: int = 0) -> None:
        page = AUTHORIZE_PAGE.format(
            when=html.escape(time.strftime("%H:%M", time.localtime(created or now()))),
            client=html.escape(client_name),
            host=html.escape(self.app.public_host),
            redirect_host=html.escape(urllib.parse.urlsplit(redirect).hostname or "?"),
            request_id=html.escape(request_id),
            error=f'<p class="err">{html.escape(error)}</p>' if error else "",
        )
        self.send_html(200, page)

    def authorize_post(self) -> None:
        body = self.read_body()
        if body is None:
            return
        form = dict(urllib.parse.parse_qsl(body.decode(errors="replace")))
        store = self.app.store
        with store.lock:
            store.prune()
            req = store.pending.get(form.get("request_id", ""))
        if not req:
            return self.message(400, "This page expired", "Go back to Claude and click Connect again.")
        client = store.clients.get(req["client_id"], {"name": "Claude"})

        def back(params: dict) -> None:
            params["iss"] = self.app.issuer
            if req.get("state"):
                params["state"] = req["state"]
            with store.lock:
                store.pending.pop(form.get("request_id", ""), None)
            self.send(302, b"", "text/plain", {"Location": req["redirect_uri"] + "?" + urllib.parse.urlencode(params)})

        if form.get("action") == "deny":
            log("sign-in denied by owner")
            return back({"error": "access_denied"})

        rid = form.get("request_id", "")
        with store.lock:
            locked = len(store.failures) >= LOCKOUT_FAILURES
            if not locked:
                # Count this attempt as a failure *before* the slow check, so
                # parallel guesses can't slip past the lockout.
                slot = now()
                store.failures.append(slot)
        if locked:
            log(f"sign-in locked out ({safe(self.client_ip())})")
            return self.render_authorize(
                rid, client["name"], req["redirect_uri"],
                "Too many wrong codes. Wait 15 minutes, then try again.", req["created"],
            )
        result = self.app.check_code(form.get("code", ""))
        if result != "ok":
            with store.lock:
                if result != "wrong":  # right code, just used or expired: not a guess
                    release(store.failures, slot)
                req["fails"] += 1
                global_left = LOCKOUT_FAILURES - len(store.failures)
                page_left = FAILURES_PER_REQUEST - req["fails"]
                if page_left <= 0:
                    store.pending.pop(rid, None)
            log(f"pairing code rejected ({result}) from {safe(self.client_ip())}")
            if result == "used":
                msg = ("That pairing code was already used. Codes work once. At the TV, run "
                       "python3 ~/.local/share/tv-connector/tv-connector.py new-code and use the new one.")
            elif result == "expired":
                msg = ("That pairing code has expired. At the TV, run "
                       "python3 ~/.local/share/tv-connector/tv-connector.py new-code and use the new one.")
            elif global_left <= 0:
                msg = "That code isn't right, and that was the last try. Wait 15 minutes, then try again."
            elif page_left <= 0:
                return self.message(400, "Too many wrong codes", "Go back to Claude and click Connect to try again.")
            else:
                msg = f"That code isn't right. {min(global_left, page_left)} tries left."
            return self.render_authorize(rid, client["name"], req["redirect_uri"], msg, req["created"])
        with store.lock:
            release(store.failures, slot)

        code = secrets.token_urlsafe(32)
        with store.lock:
            store.codes[sha256_hex(code)] = {
                "client_id": req["client_id"],
                "redirect_uri": req["redirect_uri"],
                "code_challenge": req["code_challenge"],
                "resource": req.get("resource"),
                "exp": now() + AUTH_CODE_TTL,
            }
        log(f"owner approved sign-in for client {req['client_id']} from {safe(self.client_ip())}; pairing code now used up")
        back({"code": code})

    def token(self) -> None:
        body = self.read_body()
        if body is None:
            return
        ctype = self.headers.get("Content-Type", "")
        if "json" in ctype:
            try:
                form = {k: str(v) for k, v in json.loads(body or b"{}").items()}
            except (json.JSONDecodeError, AttributeError):
                return self.send_json(400, {"error": "invalid_request"})
        else:
            form = dict(urllib.parse.parse_qsl(body.decode(errors="replace")))
        store = self.app.store
        grant = form.get("grant_type")
        client_id = form.get("client_id", "")

        def bad(err: str, desc: str = "") -> None:
            payload = {"error": err}
            if desc:
                payload["error_description"] = desc
            self.send_json(400, payload)

        with store.lock:
            store.prune()
            if client_id not in store.clients:
                return self.send_json(401, {"error": "invalid_client"})

            if grant == "authorization_code":
                rec = store.codes.pop(sha256_hex(form.get("code", "")), None)
                if not rec or rec["client_id"] != client_id:
                    return bad("invalid_grant", "code is invalid or expired")
                if form.get("redirect_uri") and form["redirect_uri"] != rec["redirect_uri"]:
                    return bad("invalid_grant", "redirect_uri mismatch")
                verifier = form.get("code_verifier", "")
                expected = b64url(hashlib.sha256(verifier.encode()).digest())
                if not verifier or not hmac.compare_digest(expected, rec["code_challenge"]):
                    return bad("invalid_grant", "PKCE verification failed")
            elif grant == "refresh_token":
                token_hash = sha256_hex(form.get("refresh_token", ""))
                rec = store.refresh.pop(token_hash, None)
                if not rec:
                    used = store.used_refresh.get(token_hash)
                    if used and now() - used["rotated"] > REFRESH_REUSE_GRACE:
                        # An old token came back: someone may have copied it. Sign that client out.
                        store.revoke_client(used["client_id"])
                        store.save()
                        log(f"refresh token replayed for client {used['client_id']}; signed it out")
                    return bad("invalid_grant", "refresh token is invalid or expired")
                if rec["client_id"] != client_id:
                    store.save()
                    return bad("invalid_grant", "refresh token is invalid or expired")
                store.used_refresh[token_hash] = {"client_id": client_id, "rotated": now(), "exp": now() + REFRESH_TTL}
            else:
                return bad("unsupported_grant_type")

            access = secrets.token_urlsafe(32)
            refresh = secrets.token_urlsafe(32)
            store.access[sha256_hex(access)] = {"client_id": client_id, "exp": now() + ACCESS_TTL}
            store.refresh[sha256_hex(refresh)] = {"client_id": client_id, "exp": now() + REFRESH_TTL}
            store.save()
        self.send_json(
            200,
            {
                "access_token": access,
                "token_type": "Bearer",
                "expires_in": ACCESS_TTL,
                "refresh_token": refresh,
                "scope": SCOPE,
            },
            {"Pragma": "no-cache"},
        )

    # ---- MCP (Streamable HTTP, JSON responses) ----

    def bearer_client(self) -> str | None:
        auth = self.headers.get("Authorization", "")
        if not auth.lower().startswith("bearer "):
            return None
        token = auth[7:].strip()
        with self.app.store.lock:
            rec = self.app.store.access.get(sha256_hex(token))
            if not rec or rec["exp"] < now():
                return None
            return rec["client_id"]

    def mcp(self, method: str) -> None:
        origin = self.headers.get("Origin")
        if origin and origin not in ("https://claude.ai", self.app.public_url):
            return self.send_json(403, {"error": "origin not allowed"})
        client_id = self.bearer_client()
        if not client_id:
            return self.send_json(
                401,
                {"error": "invalid_token"},
                {
                    "WWW-Authenticate": f'Bearer resource_metadata="{self.app.public_url}/.well-known/oauth-protected-resource", scope="{SCOPE}"'
                },
            )
        if method != "POST":
            return self.send(405, b"", "text/plain", {"Allow": "POST"})
        body = self.read_body()
        if body is None:
            return
        try:
            msg = json.loads(body)
        except json.JSONDecodeError:
            return self.send_json(400, {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}})
        if isinstance(msg, list):
            replies = [r for r in (self.app.handle_rpc(m, client_id) for m in msg) if r is not None]
            return self.send_json(200, replies) if replies else self.send(202)
        reply = self.app.handle_rpc(msg, client_id)
        if reply is None:
            return self.send(202, b"", "text/plain")
        self.send_json(200, reply)


class App:
    def __init__(self, config: dict, store: Store):
        self.config = config
        self.store = store
        self.public_url = config["public_url"].rstrip("/")
        self.issuer = self.public_url
        self.public_host = urllib.parse.urlsplit(self.public_url).hostname or self.public_url
        self.networks = [ipaddress.ip_network(n) for n in config["allowed_networks"]]
        self.resources = {self.public_url + "/mcp", self.public_url}
        self.code_lock = threading.Lock()

    def check_code(self, code: str) -> str:
        """'ok' (and marks the code used), 'wrong', 'used' or 'expired'.

        Reads the config file every time, so `new-code` works without a restart.
        One check at a time: PBKDF2 is deliberately slow.
        """
        with self.code_lock:
            cfg = load_config()
            if not cfg.get("code_hash"):
                return "wrong"
            salt = bytes.fromhex(cfg["code_salt"])
            if not hmac.compare_digest(hash_code(code, salt), cfg["code_hash"]):
                return "wrong"
            if cfg.get("code_used"):
                return "used"
            if now() - int(cfg.get("code_created", 0)) > CODE_TTL:
                return "expired"
            cfg["code_used"] = now()
            write_json_private(CONFIG_FILE, cfg)
            return "ok"

    def resource_metadata(self) -> dict:
        return {
            "resource": self.public_url + "/mcp",
            "authorization_servers": [self.issuer],
            "scopes_supported": [SCOPE],
            "bearer_methods_supported": ["header"],
            "resource_name": f"TV PC ({socket.gethostname()})",
        }

    def as_metadata(self) -> dict:
        return {
            "issuer": self.issuer,
            "authorization_endpoint": self.public_url + "/authorize",
            "token_endpoint": self.public_url + "/token",
            "registration_endpoint": self.public_url + "/register",
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "code_challenge_methods_supported": ["S256"],
            "token_endpoint_auth_methods_supported": ["none"],
            "scopes_supported": [SCOPE],
            "authorization_response_iss_parameter_supported": True,
        }

    def handle_rpc(self, msg: object, client_id: str) -> dict | None:
        if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
            return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid Request"}}
        method = msg.get("method")
        rid = msg.get("id")
        if rid is None:  # notification (or a response) — nothing to say
            return None
        params = msg.get("params") or {}

        def ok(result: dict) -> dict:
            return {"jsonrpc": "2.0", "id": rid, "result": result}

        if method == "initialize":
            requested = params.get("protocolVersion")
            version = requested if requested in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]
            return ok(
                {
                    "protocolVersion": version,
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": "tv-pc", "title": "TV PC", "version": VERSION},
                    "instructions": INSTRUCTIONS,
                }
            )
        if method == "ping":
            return ok({})
        if method == "tools/list":
            return ok(
                {
                    "tools": [
                        {
                            "name": name,
                            "description": t["description"],
                            "inputSchema": t["schema"],
                            "annotations": t["annotations"],
                        }
                        for name, t in TOOLS.items()
                    ]
                }
            )
        if method == "tools/call":
            name = params.get("name")
            args = params.get("arguments") or {}
            tool = TOOLS.get(name)
            if not tool or not isinstance(args, dict):
                return {"jsonrpc": "2.0", "id": rid, "error": {"code": -32602, "message": f"Unknown tool {name}"}}
            detail = args.get("command") or args.get("path") or args.get("job_id") or ""
            log(f"TOOL {name} [{client_id}] {safe(detail)}")
            try:
                result = tool["fn"](args, self.store)
            except (ValueError, TypeError) as e:
                result = (f"Bad arguments: {e}", True)
            except Exception as e:
                log("tool error", name, repr(e))
                result = (f"Tool failed: {e}", True)
            if isinstance(result, dict):  # rich content (e.g. an image)
                return ok(result)
            text, is_error = result
            return ok({"content": [{"type": "text", "text": text}], "isError": is_error})
        return {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"Method not found: {method}"}}


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request: object, client_address: object) -> None:
        # One line instead of a traceback (e.g. a client hanging up early).
        log(f"connection error: {safe(repr(sys.exc_info()[1]), 200)}")


def serve() -> None:
    config = load_config()
    missing = [k for k in ("public_url", "code_hash", "code_salt") if not config.get(k)]
    if missing:
        sys.exit(f"Not set up yet (missing {', '.join(missing)}). Run: {sys.argv[0]} setup --public-url https://…")
    store = Store()
    app = App(config, store)
    server = Server(("127.0.0.1", int(config["port"])), Handler)
    server.app = app  # type: ignore[attr-defined]
    log(f"TV connector {VERSION} listening on 127.0.0.1:{config['port']} for {app.public_url}/mcp")
    log(f"accepting MCP traffic from {', '.join(config['allowed_networks'])}")

    def stop(*_: object) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    server.serve_forever()


# --------------------------------------------------------------------------
# Command line
# --------------------------------------------------------------------------


def set_code(config: dict, code: str) -> None:
    salt = secrets.token_bytes(16)
    config["code_salt"] = salt.hex()
    config["code_hash"] = hash_code(code, salt)
    config["code_created"] = now()
    config.pop("code_used", None)


def print_code(code: str) -> None:
    print()
    print("  Pairing code (type it once when Claude connects; it works once, within 7 days):")
    print()
    print(f"      {code}")
    print()


def cmd_setup(args: argparse.Namespace) -> None:
    config = load_config()
    if args.public_url:
        url = args.public_url.rstrip("/")
        if not url.startswith("https://"):
            sys.exit("--public-url must start with https://")
        config["public_url"] = url
    if args.port:
        config["port"] = args.port
    new_code = None
    if not config.get("code_hash") or args.new_code:
        new_code = make_pairing_code()
        set_code(config, new_code)
    write_json_private(CONFIG_FILE, config)
    print(f"Saved {CONFIG_FILE}")
    if new_code:
        print_code(new_code)


def cmd_new_code(_args: argparse.Namespace) -> None:
    config = load_config()
    code = make_pairing_code()
    set_code(config, code)
    write_json_private(CONFIG_FILE, config)
    print_code(code)
    print("The old code no longer works. Existing Claude connections stay signed in.")
    print("This code works once, within 7 days.")


def cmd_revoke(_args: argparse.Namespace) -> None:
    # Stop the service first so it can't write its in-memory tokens back.
    running = run(["systemctl", "--user", "is-active", "--quiet", "tv-connector"])[0] == 0
    if running:
        run(["systemctl", "--user", "stop", "tv-connector"], timeout=30)
    Store().revoke_all()
    if running:
        run(["systemctl", "--user", "start", "tv-connector"], timeout=30)
    print("Signed Claude out everywhere. To use it again, reconnect from Claude (you'll need the pairing code).")


def cmd_status(_args: argparse.Namespace) -> None:
    config = load_config()
    store = Store()
    store.prune()
    print(f"TV connector {VERSION}")
    print(f"Address for Claude:  {config.get('public_url', '(not set)')}/mcp")
    print(f"Port:                127.0.0.1:{config['port']}")
    print(f"Accepts MCP from:    {', '.join(config['allowed_networks'])}")
    if not config.get("code_hash"):
        code_state = "none"
    elif config.get("code_used"):
        code_state = "used (run new-code to connect another Claude)"
    elif now() - int(config.get("code_created", 0)) > CODE_TTL:
        code_state = "expired (run new-code)"
    else:
        code_state = "ready"
    print(f"Pairing code:        {code_state}")
    print(f"Registered clients:  {len(store.clients)}")
    print(f"Signed-in sessions:  {len(store.refresh)}")


def main() -> None:
    parser = argparse.ArgumentParser(description="TV connector: MCP server for controlling this PC from Claude.")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("serve", help="run the server")
    p = sub.add_parser("setup", help="save the public address; make a pairing code if there isn't one")
    p.add_argument("--public-url", help="https://NAME.TAILNET.ts.net (Tailscale Funnel address)")
    p.add_argument("--port", type=int)
    p.add_argument("--new-code", action="store_true", help="replace the pairing code")
    sub.add_parser("new-code", help="make a new pairing code")
    sub.add_parser("revoke", help="sign Claude out everywhere")
    sub.add_parser("status", help="show settings")
    args = parser.parse_args()
    {"serve": lambda a: serve(), "setup": cmd_setup, "new-code": cmd_new_code, "revoke": cmd_revoke, "status": cmd_status}[
        args.cmd
    ](args)


if __name__ == "__main__":
    main()
