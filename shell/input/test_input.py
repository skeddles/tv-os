#!/usr/bin/env python3
"""Tests for tvlauncher-input.py that don't need a controller or /dev/uinput."""

import importlib.util
import io
import json
import sys
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("tvi", Path(__file__).with_name("tvlauncher-input.py"))
tvi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tvi)


class FakeVI:
    def __init__(self):
        self.log = []

    def rel(self, dx=0, dy=0, wheel=0, hwheel=0):
        self.log.append(("rel", dx, dy, wheel, hwheel))

    def notch(self, wheel=0, hwheel=0):
        self.log.append(("notch", wheel, hwheel))

    def button(self, code, down):
        self.log.append(("button", code, down))

    def tap(self, name, shift=False, alt=False):
        self.log.append(("tap", name, shift, alt))

    def type_text(self, text):
        for ch in text:
            self.log.append(("char", ch))
        return 0

    def park(self):
        self.log.append(("park",))


class FakePad:
    node = "event99"
    name = "fake"

    def __init__(self):
        self.axes = {}

    def norm(self, code, value):
        return tvi.Pad.norm(self, code, value)

    ranges = {tvi.ABS_X: (-32768, 32767), tvi.ABS_Y: (-32768, 32767), tvi.ABS_RZ: (0, 1023)}


def make_helper():
    h = tvi.Helper.__new__(tvi.Helper)
    h.mouse = False
    h.pads = {}
    h.guide_down_at = None
    h.guide_toggled = False
    h.frac = [0.0] * 4
    h.notch_acc = [0.0, 0.0]
    h.held = set()
    h.vi = FakeVI()
    h.abs = FakeAbs()
    return h


class FakeAbs:
    def __init__(self):
        self.moves = []

    def move(self, fx, fy):
        self.moves.append((fx, fy))


class InputTest(unittest.TestCase):
    def setUp(self):
        self.out = io.StringIO()
        self._stdout = sys.stdout
        sys.stdout = self.out

    def tearDown(self):
        sys.stdout = self._stdout

    def events(self):
        return [json.loads(line)["ev"] for line in self.out.getvalue().splitlines()]

    def test_ioctl_numbers_match_kernel_headers(self):
        self.assertEqual(tvi.UI_SET_EVBIT, 0x40045564)
        self.assertEqual(tvi.UI_SET_KEYBIT, 0x40045565)
        self.assertEqual(tvi.UI_SET_RELBIT, 0x40045566)
        self.assertEqual(tvi.UI_DEV_SETUP, 0x405C5503)
        self.assertEqual(tvi.UI_DEV_CREATE, 0x5501)
        self.assertEqual(tvi.UI_DEV_DESTROY, 0x5502)
        self.assertEqual(tvi.eviocgabs(0), 0x80184540)
        self.assertEqual(tvi.UI_SET_ABSBIT, 0x40045567)
        self.assertEqual(tvi.UI_ABS_SETUP, 0x401C5504)
        self.assertEqual(tvi.EVENT.size, 24)

    def test_every_printable_ascii_char_is_typeable(self):
        missing = [c for c in map(chr, range(32, 127)) if c not in tvi.CHARS]
        self.assertEqual(missing, [])
        self.assertEqual(tvi.CHARS["A"], ("a", True))
        self.assertEqual(tvi.CHARS["?"], ("slash", True))

    def test_deadzone_and_curve(self):
        self.assertEqual(tvi.shape(0.1), 0.0)
        self.assertEqual(tvi.shape(-0.1), 0.0)
        self.assertAlmostEqual(tvi.shape(1.0), 1.0)
        self.assertAlmostEqual(tvi.shape(-1.0), -1.0)
        self.assertLess(tvi.shape(0.5), 0.5)  # gentle near the centre

    def test_short_guide_press_is_home(self):
        h = make_helper()
        h.on_button(tvi.BTN_MODE, True)
        h.tick(0.01)
        h.on_button(tvi.BTN_MODE, False)
        self.assertEqual(self.events(), ["home"])

    def test_long_guide_press_toggles_and_is_not_home(self):
        h = make_helper()
        h.on_button(tvi.BTN_MODE, True)
        h.guide_down_at -= tvi.HOLD_TOGGLE + 0.05
        h.tick(0.01)
        h.tick(0.01)  # fires once
        h.on_button(tvi.BTN_MODE, False)
        self.assertEqual(self.events(), ["toggle-mouse"])

    def test_buttons_do_nothing_when_mouse_mode_off(self):
        h = make_helper()
        for code in (tvi.BTN_A, tvi.BTN_X, tvi.BTN_Y, tvi.BTN_START):
            h.on_button(code, True)
            h.on_button(code, False)
        h.on_hat(tvi.ABS_HAT0X, 1)
        self.assertEqual(h.vi.log, [])
        self.assertEqual(self.events(), [])

    def test_mouse_mode_mapping(self):
        h = make_helper()
        h.set_mouse(True)
        h.on_button(tvi.BTN_A, True)
        h.on_button(tvi.BTN_A, False)
        h.on_button(tvi.BTN_X, True)
        h.on_button(tvi.BTN_START, True)
        h.on_button(tvi.BTN_SELECT, True)
        h.on_button(tvi.BTN_TL, True)
        h.on_hat(tvi.ABS_HAT0Y, -1)
        h.on_hat(tvi.ABS_HAT0Y, 0)
        h.on_button(tvi.BTN_Y, True)
        self.assertEqual(
            h.vi.log,
            [
                ("button", tvi.BTN_LEFT, True),
                ("button", tvi.BTN_LEFT, False),
                ("tap", "space", False, False),
                ("tap", "enter", False, False),
                ("tap", "esc", False, False),
                ("tap", "left", False, True),
                ("tap", "up", False, False),
            ],
        )
        self.assertEqual(self.events(), ["click", "keyboard"])

    def test_turning_mouse_off_releases_held_buttons_and_parks(self):
        h = make_helper()
        h.set_mouse(True)
        h.on_button(tvi.BTN_A, True)  # dragging
        h.set_mouse(False)
        self.assertIn(("button", tvi.BTN_LEFT, False), h.vi.log)
        self.assertEqual(h.abs.moves, [(0.5, 0.5), (1.0, 1.0)])  # centred on, parked off

    def test_stick_moves_pointer_and_trigger_slows_it(self):
        h = make_helper()
        pad = FakePad()
        h.pads = {"event99": pad}
        h.set_mouse(True)
        pad.axes[tvi.ABS_X] = 1.0
        h.tick(0.1)
        fast = h.vi.log[-1][1]
        pad.axes[tvi.ABS_RZ] = 1.0
        h.tick(0.1)
        slow = h.vi.log[-1][1]
        self.assertAlmostEqual(fast, tvi.POINTER_SPEED * 0.1, delta=2)
        self.assertLess(slow, fast / 2)

    def test_right_stick_scrolls_with_notches(self):
        h = make_helper()
        pad = FakePad()
        h.pads = {"event99": pad}
        h.set_mouse(True)
        pad.axes[tvi.ABS_RY] = -1.0  # push up = scroll up
        for _ in range(20):
            h.tick(0.01)
        rels = [e for e in h.vi.log if e[0] == "rel"]
        notches = [e for e in h.vi.log if e[0] == "notch"]
        self.assertTrue(all(e[3] > 0 for e in rels))
        self.assertTrue(notches and all(e[1] == 1 for e in notches))

    def test_trigger_normalises_0_to_1(self):
        pad = FakePad()
        self.assertAlmostEqual(pad.norm(tvi.ABS_RZ, 1023), 1.0)
        self.assertAlmostEqual(pad.norm(tvi.ABS_X, 32767), 1.0, places=3)
        self.assertAlmostEqual(pad.norm(tvi.ABS_X, -32768), -1.0, places=3)

    def test_type_command(self):
        h = make_helper()
        h.on_command({"cmd": "type", "text": "Hi!", "enter": True})
        self.assertEqual(h.vi.log, [("char", "H"), ("char", "i"), ("char", "!"), ("tap", "enter", False, False)])


if __name__ == "__main__":
    unittest.main(verbosity=1)
