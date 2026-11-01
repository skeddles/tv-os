#!/usr/bin/env python3
"""Tells the launcher shell when an app focuses a text field, so the on-screen
keyboard can open by itself (Python + the AT-SPI accessibility bus).

Cage doesn't tell other programs when a text field is focused (it has no
text-input protocol), but apps report focus to the Linux accessibility bus,
the same way GNOME's on-screen keyboard finds out. Firefox does (seen on the TV:
"combo box, editable" for the address bar).

stdout: {"ev": "text-focus", "app": "Firefox", "role": "entry", "password": false}
        {"ev": "ready"}
"""

import ctypes
import json
import signal
import sys

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi, GLib  # noqa: E402

TEXT_ROLES = {
    "entry",
    "password text",
    "text",
    "combo box",
    "search box",  # newer at-spi names
    "terminal",
    "spin button",
}


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def enable_accessibility():
    """Ask apps to expose their accessibility info (browsers only do when something listens)."""
    try:
        import dbus

        bus = dbus.SessionBus()
        props = dbus.Interface(bus.get_object("org.a11y.Bus", "/org/a11y/bus"), "org.freedesktop.DBus.Properties")
        props.Set("org.a11y.Status", "IsEnabled", dbus.Boolean(True))
    except Exception as e:  # not fatal: some apps still report
        sys.stderr.write(f"[a11y] couldn't enable accessibility: {e}\n")


def on_focus(ev):
    if not ev.detail1:  # focus lost
        return
    try:
        acc = ev.source
        states = acc.get_state_set()
        role = acc.get_role_name()
        editable = states.contains(Atspi.StateType.EDITABLE)
        if not editable or (role not in TEXT_ROLES and role != "document text"):
            return
        app = acc.get_application()
        emit(
            {
                "ev": "text-focus",
                "app": app.get_name() if app else "",
                "role": role,
                "password": role == "password text",
            }
        )
    except Exception:  # objects vanish while we look at them
        pass


def exit_with_parent():
    """Exit when the shell goes away, so a leftover helper can't keep the session open."""
    try:  # Linux: get SIGTERM when the parent dies
        ctypes.CDLL("libc.so.6", use_errno=True).prctl(1, signal.SIGTERM)  # PR_SET_PDEATHSIG
    except OSError:
        pass

    def on_stdin(_fd, cond):
        if cond & (GLib.IOCondition.HUP | GLib.IOCondition.ERR) or not sys.stdin.buffer.read1(4096):
            Atspi.event_quit()
            return False
        return True

    GLib.io_add_watch(sys.stdin.fileno(), GLib.IOCondition.IN | GLib.IOCondition.HUP | GLib.IOCondition.ERR, on_stdin)


def main():
    exit_with_parent()
    enable_accessibility()
    listener = Atspi.EventListener.new(on_focus)
    listener.register("object:state-changed:focused")
    emit({"ev": "ready"})
    Atspi.event_main()


if __name__ == "__main__":
    main()
