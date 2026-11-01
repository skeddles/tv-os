// Runs inside web apps opened as layers. Tells the shell when a text field gets
// focus, so the on-screen keyboard can open when you click one.
const { ipcRenderer } = require('electron')

function isTextField(el) {
  if (!el) return false
  if (el.isContentEditable) return true
  if (el.tagName === 'TEXTAREA') return true
  if (el.tagName !== 'INPUT') return false
  const t = (el.type || 'text').toLowerCase()
  return ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(t)
}

window.addEventListener(
  'focusin',
  (e) => {
    if (isTextField(e.target)) {
      ipcRenderer.send('tv:text-focus', { role: e.target.tagName.toLowerCase(), password: e.target.type === 'password' })
    }
  },
  true,
)
