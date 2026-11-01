// Runs inside web apps opened as layers (e.g. Twitch). Watches the controller
// for "go home": the Xbox button, or View + Menu held together.
// The main process also watches the Xbox button directly (lib/evdev.cjs);
// this is the fallback when the controller's device file isn't readable.
const { ipcRenderer } = require('electron')

let wasDown = false
function poll() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : []
  let down = false
  for (const p of pads) {
    if (!p) continue
    const b = (i) => Boolean(p.buttons[i] && p.buttons[i].pressed)
    if (b(16) || (b(8) && b(9))) down = true
  }
  if (down && !wasDown) ipcRenderer.send('tv:home')
  wasDown = down
  requestAnimationFrame(poll)
}
window.addEventListener('DOMContentLoaded', () => requestAnimationFrame(poll))
