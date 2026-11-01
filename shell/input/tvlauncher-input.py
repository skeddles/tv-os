#!/usr/bin/env python3
"""Controller helper for the TV launcher shell (Python standard library only).

Reads game controllers straight from /dev/input (the logged-in user may, via
systemd's uaccess rule) and, when asked, turns the controller into a mouse and
keyboard through a virtual uinput device, so apps without controller support
still work.

Talks to the Electron shell with JSON lines:
  stdin  (commands): {"cmd": "mouse", "on": true}
                     {"cmd": "type", "text": "hello", "enter": false}
                     {"cmd": "key", "key": "enter"}
                     {"cmd": "park"}            move the pointer out of the way
  stdout (events):   {"ev": "ready", "uinput": true}
                     {"ev": "click"}            A pressed in mouse mode (lets the shell
                                                open the keyboard on text fields)
                     {"ev": "home"}             Xbox button, short press
                     {"ev": "volume", "step": 1}  View held + D-pad up/down (anywhere)
                     {"ev": "toggle-mouse"}     Xbox button held ~0.7 s
                     {"ev": "keyboard"}         Y, while in mouse mode
                     {"ev": "controller", "name": "...", "connected": true}

Mouse mode (Xbox One pad, xpad driver):
  left stick  pointer (hold RT for slow, precise movement)
  right stick scroll
  A / B       left / right click        X        Space (play/pause)
  Y           on-screen keyboard        D-pad    arrow keys
  Menu        Enter                     View     Escape (on release, if no chord)
  View + D-pad up/down: volume (in the launcher and in apps)
  LB / RB     Back / Forward            L3 / R3  middle click / Tab
"""

from __future__ import annotations

import fcntl
import json
import os
import select
import struct
import sys
import time

# ---- Linux input constants -------------------------------------------------

EV_SYN, EV_KEY, EV_REL, EV_ABS = 0, 1, 2, 3
SYN_REPORT = 0
REL_X, REL_Y, REL_HWHEEL, REL_WHEEL = 0, 1, 6, 8
REL_WHEEL_HI_RES, REL_HWHEEL_HI_RES = 11, 12
ABS_X, ABS_Y, ABS_Z, ABS_RX, ABS_RY, ABS_RZ = 0, 1, 2, 3, 4, 5
ABS_HAT0X, ABS_HAT0Y = 0x10, 0x11

BTN_LEFT, BTN_RIGHT, BTN_MIDDLE = 0x110, 0x111, 0x112
BTN_A, BTN_B, BTN_X, BTN_Y = 0x130, 0x131, 0x133, 0x134
BTN_TL, BTN_TR = 0x136, 0x137
BTN_SELECT, BTN_START, BTN_MODE = 0x13A, 0x13B, 0x13C
BTN_THUMBL, BTN_THUMBR = 0x13D, 0x13E

KEY = {
    "esc": 1, "1": 2, "2": 3, "3": 4, "4": 5, "5": 6, "6": 7, "7": 8, "8": 9, "9": 10, "0": 11,
    "minus": 12, "equal": 13, "backspace": 14, "tab": 15,
    "q": 16, "w": 17, "e": 18, "r": 19, "t": 20, "y": 21, "u": 22, "i": 23, "o": 24, "p": 25,
    "leftbrace": 26, "rightbrace": 27, "enter": 28, "leftctrl": 29,
    "a": 30, "s": 31, "d": 32, "f": 33, "g": 34, "h": 35, "j": 36, "k": 37, "l": 38,
    "semicolon": 39, "apostrophe": 40, "grave": 41, "leftshift": 42, "backslash": 43,
    "z": 44, "x": 45, "c": 46, "v": 47, "b": 48, "n": 49, "m": 50,
    "comma": 51, "dot": 52, "slash": 53, "leftalt": 56, "space": 57,
    "home": 102, "up": 103, "pageup": 104, "left": 105, "right": 106, "end": 107, "down": 108,
    "pagedown": 109, "delete": 111, "back": 158, "forward": 159,
}

# US layout: character -> (key name, shift)
CHARS: dict[str, tuple[str, bool]] = {" ": ("space", False), "\n": ("enter", False), "\t": ("tab", False)}
for c in "abcdefghijklmnopqrstuvwxyz":
    CHARS[c] = (c, False)
    CHARS[c.upper()] = (c, True)
for c in "1234567890":
    CHARS[c] = (c, False)
for c, (name, shift) in {
    "!": ("1", True), "@": ("2", True), "#": ("3", True), "$": ("4", True), "%": ("5", True),
    "^": ("6", True), "&": ("7", True), "*": ("8", True), "(": ("9", True), ")": ("0", True),
    "-": ("minus", False), "_": ("minus", True), "=": ("equal", False), "+": ("equal", True),
    "[": ("leftbrace", False), "{": ("leftbrace", True), "]": ("rightbrace", False), "}": ("rightbrace", True),
    ";": ("semicolon", False), ":": ("semicolon", True), "'": ("apostrophe", False), '"': ("apostrophe", True),
    "`": ("grave", False), "~": ("grave", True), "\\": ("backslash", False), "|": ("backslash", True),
    ",": ("comma", False), "<": ("comma", True), ".": ("dot", False), ">": ("dot", True),
    "/": ("slash", False), "?": ("slash", True),
}.items():
    CHARS[c] = (name, shift)

EVENT = struct.Struct("llHHi")  # struct input_event on 64-bit Linux (24 bytes)


def _ioc(direction: int, type_: str, nr: int, size: int) -> int:
    return (direction << 30) | (size << 16) | (ord(type_) << 8) | nr


UI_SET_EVBIT = _ioc(1, "U", 100, 4)
UI_SET_KEYBIT = _ioc(1, "U", 101, 4)
UI_SET_RELBIT = _ioc(1, "U", 102, 4)
UI_SET_ABSBIT = _ioc(1, "U", 103, 4)
UI_ABS_SETUP = _ioc(1, "U", 4, 28)
UI_DEV_SETUP = _ioc(1, "U", 3, 92)
UI_DEV_CREATE = _ioc(0, "U", 1, 0)
UI_DEV_DESTROY = _ioc(0, "U", 2, 0)


def eviocgabs(code: int) -> int:
    return _ioc(2, "E", 0x40 + code, 24)


# ---- tuning ----------------------------------------------------------------

DEADZONE = 0.15
POINTER_SPEED = 1300.0  # px per second at full tilt
SLOW_FACTOR = 0.3  # while RT is held
SCROLL_SPEED = 2400.0  # hi-res wheel units per second at full tilt (120 = one notch)
HOLD_TOGGLE = 0.7  # seconds holding the Xbox button to toggle mouse mode
TICK = 1 / 120


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def log(msg: str) -> None:
    sys.stderr.write(f"[input] {msg}\n")
    sys.stderr.flush()


def shape(v: float) -> float:
    """Deadzone, then a squared curve for fine control near the centre."""
    a = abs(v)
    if a < DEADZONE:
        return 0.0
    a = (a - DEADZONE) / (1 - DEADZONE)
    return (a * a) * (1 if v > 0 else -1)


# ---- virtual mouse + keyboard ----------------------------------------------


class VirtualInput:
    def __init__(self) -> None:
        self.fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
        for ev in (EV_KEY, EV_REL, EV_SYN):
            fcntl.ioctl(self.fd, UI_SET_EVBIT, ev)
        for code in set(KEY.values()) | {BTN_LEFT, BTN_RIGHT, BTN_MIDDLE}:
            fcntl.ioctl(self.fd, UI_SET_KEYBIT, code)
        for rel in (REL_X, REL_Y, REL_WHEEL, REL_HWHEEL, REL_WHEEL_HI_RES, REL_HWHEEL_HI_RES):
            fcntl.ioctl(self.fd, UI_SET_RELBIT, rel)
        # struct uinput_setup { struct input_id {u16 bustype, vendor, product, version}; char name[80]; u32 ff_effects_max; }
        setup = struct.pack("HHHH80sI", 0x06, 0x1209, 0x7476, 1, b"TV launcher controller mouse", 0)
        fcntl.ioctl(self.fd, UI_DEV_SETUP, setup)
        fcntl.ioctl(self.fd, UI_DEV_CREATE)

    def _write(self, type_: int, code: int, value: int) -> None:
        os.write(self.fd, EVENT.pack(0, 0, type_, code, value))

    def sync(self) -> None:
        self._write(EV_SYN, SYN_REPORT, 0)

    def rel(self, dx: int = 0, dy: int = 0, wheel: int = 0, hwheel: int = 0) -> None:
        if dx:
            self._write(EV_REL, REL_X, dx)
        if dy:
            self._write(EV_REL, REL_Y, dy)
        if wheel:
            self._write(EV_REL, REL_WHEEL_HI_RES, wheel)
        if hwheel:
            self._write(EV_REL, REL_HWHEEL_HI_RES, hwheel)
        self.sync()

    def notch(self, wheel: int = 0, hwheel: int = 0) -> None:
        """Legacy whole-notch scroll events, for apps that ignore hi-res ones."""
        if wheel:
            self._write(EV_REL, REL_WHEEL, wheel)
        if hwheel:
            self._write(EV_REL, REL_HWHEEL, hwheel)
        self.sync()

    def button(self, code: int, down: bool) -> None:
        self._write(EV_KEY, code, 1 if down else 0)
        self.sync()

    def tap(self, name: str, shift: bool = False, alt: bool = False) -> None:
        if shift:
            self._write(EV_KEY, KEY["leftshift"], 1)
        if alt:
            self._write(EV_KEY, KEY["leftalt"], 1)
        self._write(EV_KEY, KEY[name], 1)
        self.sync()
        self._write(EV_KEY, KEY[name], 0)
        if alt:
            self._write(EV_KEY, KEY["leftalt"], 0)
        if shift:
            self._write(EV_KEY, KEY["leftshift"], 0)
        self.sync()

    def type_text(self, text: str) -> int:
        skipped = 0
        for ch in text:
            if ch not in CHARS:
                skipped += 1
                continue
            name, shift = CHARS[ch]
            self.tap(name, shift)
            time.sleep(0.008)  # some apps drop keys sent too fast
        return skipped

    def park(self) -> None:
        """Push the pointer to the bottom-right corner, out of sight."""
        for _ in range(6):
            self.rel(4000, 4000)

    def close(self) -> None:
        try:
            fcntl.ioctl(self.fd, UI_DEV_DESTROY)
        finally:
            os.close(self.fd)


class AbsolutePointer:
    """A second virtual device that can put the pointer at an exact spot.

    Relative moves go through pointer acceleration, so they can't place the
    pointer reliably. An absolute device (like a VM's USB tablet) can: used to
    centre the pointer when mouse mode turns on and park it when it turns off.
    """

    MAX = 65535

    def __init__(self) -> None:
        self.fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
        fcntl.ioctl(self.fd, UI_SET_EVBIT, EV_KEY)
        fcntl.ioctl(self.fd, UI_SET_EVBIT, EV_ABS)
        fcntl.ioctl(self.fd, UI_SET_EVBIT, EV_SYN)
        fcntl.ioctl(self.fd, UI_SET_KEYBIT, BTN_LEFT)  # makes it a mouse, not a joystick/tablet
        for code in (ABS_X, ABS_Y):
            fcntl.ioctl(self.fd, UI_SET_ABSBIT, code)
            # struct uinput_abs_setup { u16 code; u16 pad; struct input_absinfo { s32 value, min, max, fuzz, flat, res } }
            fcntl.ioctl(self.fd, UI_ABS_SETUP, struct.pack("HH6i", code, 0, 0, 0, self.MAX, 0, 0, 0))
        setup = struct.pack("HHHH80sI", 0x06, 0x1209, 0x7477, 1, b"TV launcher pointer position", 0)
        fcntl.ioctl(self.fd, UI_DEV_SETUP, setup)
        fcntl.ioctl(self.fd, UI_DEV_CREATE)

    def move(self, fx: float, fy: float) -> None:
        """Put the pointer at a fraction of the screen (0..1, 0..1)."""
        for code, f in ((ABS_X, fx), (ABS_Y, fy)):
            os.write(self.fd, EVENT.pack(0, 0, EV_ABS, code, int(max(0.0, min(1.0, f)) * self.MAX)))
        os.write(self.fd, EVENT.pack(0, 0, EV_SYN, SYN_REPORT, 0))

    def close(self) -> None:
        try:
            fcntl.ioctl(self.fd, UI_DEV_DESTROY)
        finally:
            os.close(self.fd)


# ---- controllers ------------------------------------------------------------


def joystick_nodes() -> dict[str, str]:
    """event device name -> human name, for devices udev marks as joysticks."""
    out = {}
    try:
        names = os.listdir("/sys/class/input")
    except OSError:
        return out
    for n in names:
        if not n.startswith("event"):
            continue
        try:
            with open(f"/sys/class/input/{n}/dev") as f:
                dev = f.read().strip()
            with open(f"/run/udev/data/c{dev}") as f:
                if "E:ID_INPUT_JOYSTICK=1" not in f.read():
                    continue
            with open(f"/sys/class/input/{n}/device/name") as f:
                out[n] = f.read().strip()
        except OSError:
            continue
    return out


class Pad:
    def __init__(self, node: str, name: str):
        self.node = node
        self.name = name
        self.fd = os.open(f"/dev/input/{node}", os.O_RDONLY | os.O_NONBLOCK)
        self.buf = b""
        self.ranges: dict[int, tuple[int, int]] = {}
        self.axes: dict[int, float] = {}
        for code in (ABS_X, ABS_Y, ABS_Z, ABS_RX, ABS_RY, ABS_RZ):
            try:
                _, lo, hi, *_ = struct.unpack("6i", fcntl.ioctl(self.fd, eviocgabs(code), b"\0" * 24))
                self.ranges[code] = (lo, hi)
            except OSError:
                pass

    def norm(self, code: int, value: int) -> float:
        lo, hi = self.ranges.get(code, (-32768, 32767))
        if lo >= 0:  # trigger: 0..1
            return (value - lo) / max(1, hi - lo)
        return max(-1.0, min(1.0, (2 * (value - lo) / max(1, hi - lo)) - 1))

    def read(self) -> list[tuple[int, int, int]]:
        try:
            self.buf += os.read(self.fd, EVENT.size * 64)
        except BlockingIOError:
            return []
        events = []
        while len(self.buf) >= EVENT.size:
            _, _, t, c, v = EVENT.unpack(self.buf[: EVENT.size])
            self.buf = self.buf[EVENT.size :]
            events.append((t, c, v))
        return events

    def close(self) -> None:
        try:
            os.close(self.fd)
        except OSError:
            pass


# ---- the helper ---------------------------------------------------------------


class Helper:
    def __init__(self) -> None:
        self.mouse = False
        self.pads: dict[str, Pad] = {}
        self.guide_down_at: float | None = None
        self.guide_toggled = False
        self.frac = [0.0, 0.0, 0.0, 0.0]  # x, y, wheel, hwheel leftovers
        self.notch_acc = [0.0, 0.0]
        self.held: set[int] = set()  # virtual buttons/keys held down
        self.view_down = False
        self.view_chord = False  # View was used for a volume chord this press
        try:
            self.vi: VirtualInput | None = VirtualInput()
        except OSError as e:
            log(f"no virtual input device ({e}); mouse mode and typing unavailable")
            self.vi = None
        try:
            self.abs: AbsolutePointer | None = AbsolutePointer() if self.vi else None
        except OSError as e:
            log(f"no absolute pointer ({e}); pointer won't be centred")
            self.abs = None
        self.wake_keyboard()
        emit({"ev": "ready", "uinput": self.vi is not None})

    def wake_keyboard(self) -> None:
        """Tap Shift once so Cage has a live keyboard to hand to windows.

        When the previous shell's virtual keyboard vanished (the shell was
        killed or crashed), Cage 0.3.1 can be left pointing at it and sends new
        windows keyboard modifiers without a keymap, which crashes Electron
        (xkb_state_update_mask). A key event from a live keyboard resets it.
        """
        if not self.vi:
            return
        time.sleep(0.3)  # let the compositor pick up the new device first
        self.vi.tap("leftshift")

    # -- devices --
    def rescan(self) -> None:
        found = joystick_nodes()
        for node, name in found.items():
            if node not in self.pads:
                try:
                    self.pads[node] = Pad(node, name)
                    log(f"controller connected: {name} ({node})")
                    emit({"ev": "controller", "name": name, "connected": True})
                except OSError as e:
                    log(f"can't open {node}: {e}")
        for node in [n for n in self.pads if n not in found]:
            self.pads.pop(node).close()
            emit({"ev": "controller", "connected": False})

    # -- mode --
    def set_mouse(self, on: bool) -> None:
        if on == self.mouse:
            return
        self.mouse = on
        self.release_all()
        if on:
            self.center()  # so you can see it switch on
        else:
            self.park()
        log(f"mouse mode {'on' if on else 'off'}")

    def center(self) -> None:
        if self.abs:
            self.abs.move(0.5, 0.5)

    def park(self) -> None:
        if self.abs:
            self.abs.move(1.0, 1.0)
        elif self.vi:
            self.vi.park()

    def release_all(self) -> None:
        if not self.vi:
            self.held.clear()
            return
        for code in list(self.held):
            self.vi.button(code, False)
        self.held.clear()

    # -- controller events --
    def on_button(self, code: int, down: bool) -> None:
        if code == BTN_MODE:
            if down:
                self.guide_down_at = time.monotonic()
                self.guide_toggled = False
            else:
                if self.guide_down_at is not None and not self.guide_toggled:
                    emit({"ev": "home"})
                self.guide_down_at = None
            return
        if code == BTN_SELECT:
            if down:
                self.view_down, self.view_chord = True, False
            else:
                self.view_down = False
                # View on its own = Escape (mouse mode); not when it was a volume chord
                if not self.view_chord and self.mouse and self.vi:
                    self.vi.tap("esc")
            return
        if not (self.mouse and self.vi):
            return
        vi = self.vi
        hold = {BTN_A: BTN_LEFT, BTN_B: BTN_RIGHT, BTN_THUMBL: BTN_MIDDLE}
        if code in hold:
            vi.button(hold[code], down)
            (self.held.add if down else self.held.discard)(hold[code])
            if code == BTN_A and down:
                emit({"ev": "click"})
            return
        if not down:
            return
        if code == BTN_Y:
            emit({"ev": "keyboard"})
        elif code == BTN_X:
            vi.tap("space")
        elif code == BTN_START:
            vi.tap("enter")
        elif code == BTN_TL:
            vi.tap("left", alt=True)  # Back in browsers
        elif code == BTN_TR:
            vi.tap("right", alt=True)  # Forward
        elif code == BTN_THUMBR:
            vi.tap("tab")

    def on_hat(self, code: int, value: int) -> None:
        if value and self.view_down and code == ABS_HAT0Y:
            self.view_chord = True
            emit({"ev": "volume", "step": 1 if value < 0 else -1})
            return
        if not (self.mouse and self.vi) or value == 0 or self.view_down:
            return
        if code == ABS_HAT0X:
            self.vi.tap("right" if value > 0 else "left")
        else:
            self.vi.tap("down" if value > 0 else "up")

    def tick(self, dt: float) -> None:
        # Xbox button held long enough: toggle (fires while still held)
        if self.guide_down_at is not None and not self.guide_toggled and time.monotonic() - self.guide_down_at >= HOLD_TOGGLE:
            self.guide_toggled = True
            emit({"ev": "toggle-mouse"})
        if not (self.mouse and self.vi) or not self.pads:
            return
        lx = ly = rx = ry = rt = 0.0
        for pad in self.pads.values():  # combine pads (usually one)
            lx += shape(pad.axes.get(ABS_X, 0.0))
            ly += shape(pad.axes.get(ABS_Y, 0.0))
            rx += shape(pad.axes.get(ABS_RX, 0.0))
            ry += shape(pad.axes.get(ABS_RY, 0.0))
            rt = max(rt, pad.axes.get(ABS_RZ, 0.0))
        speed = POINTER_SPEED * (SLOW_FACTOR if rt > 0.3 else 1.0) * dt
        moves = [lx * speed, ly * speed, -ry * SCROLL_SPEED * dt, rx * SCROLL_SPEED * dt]
        out = []
        for i, m in enumerate(moves):
            total = m + self.frac[i]
            whole = int(total)
            self.frac[i] = total - whole if m else 0.0
            out.append(whole)
        if any(out):
            self.vi.rel(*out)
        for i, v in enumerate(out[2:]):
            self.notch_acc[i] += v
            notches = int(self.notch_acc[i] / 120)
            if notches:
                self.notch_acc[i] -= notches * 120
                self.vi.notch(wheel=notches if i == 0 else 0, hwheel=notches if i == 1 else 0)

    def on_pad_events(self, pad: Pad, events: list[tuple[int, int, int]]) -> None:
        for t, c, v in events:
            if t == EV_KEY:
                self.on_button(c, v != 0)
            elif t == EV_ABS:
                if c in (ABS_HAT0X, ABS_HAT0Y):
                    self.on_hat(c, v)
                else:
                    pad.axes[c] = pad.norm(c, v)

    # -- shell commands --
    def on_command(self, msg: dict) -> None:
        cmd = msg.get("cmd")
        if cmd == "mouse":
            self.set_mouse(bool(msg.get("on")))
        elif cmd == "park":
            self.park()
        elif cmd == "center":
            self.center()
        elif cmd == "type" and self.vi:
            skipped = self.vi.type_text(str(msg.get("text", "")))
            if msg.get("enter"):
                self.vi.tap("enter")
            if skipped:
                log(f"skipped {skipped} characters with no key on a US keyboard")
        elif cmd == "key" and self.vi and msg.get("key") in KEY:
            self.vi.tap(msg["key"])

    def run(self) -> None:
        self.rescan()
        last_scan = last_tick = time.monotonic()
        stdin_buf = b""
        while True:
            fds = [sys.stdin.fileno()] + [p.fd for p in self.pads.values()]
            ready, _, _ = select.select(fds, [], [], TICK)
            for fd in ready:
                if fd == sys.stdin.fileno():
                    chunk = os.read(fd, 65536)
                    if not chunk:
                        return  # shell went away
                    stdin_buf += chunk
                    while b"\n" in stdin_buf:
                        line, stdin_buf = stdin_buf.split(b"\n", 1)
                        try:
                            self.on_command(json.loads(line))
                        except (ValueError, TypeError) as e:
                            log(f"bad command: {e}")
                    continue
                pad = next((p for p in self.pads.values() if p.fd == fd), None)
                if not pad:
                    continue
                try:
                    self.on_pad_events(pad, pad.read())
                except OSError:  # unplugged
                    self.pads.pop(pad.node, None)
                    pad.close()
                    emit({"ev": "controller", "connected": False})
            now = time.monotonic()
            self.tick(min(now - last_tick, 0.05))
            last_tick = now
            if now - last_scan > 3:
                self.rescan()
                last_scan = now


def main() -> None:
    try:  # also exit if the shell is killed outright (Linux PR_SET_PDEATHSIG)
        import ctypes
        import signal

        ctypes.CDLL("libc.so.6", use_errno=True).prctl(1, signal.SIGTERM)
    except OSError:
        pass
    helper = Helper()
    try:
        helper.run()
    finally:
        helper.release_all()
        if helper.vi:
            helper.vi.close()
        if helper.abs:
            helper.abs.close()


if __name__ == "__main__":
    main()
