// Runs the controller helper (input/tvlauncher-input.py) and restarts it if it
// stops. The helper reads the controller directly, so it works whichever app is
// in front: Xbox button (home / hold to toggle mouse mode), mouse mode, typing.
const { spawn } = require('node:child_process')
const { EventEmitter } = require('node:events')
const path = require('node:path')
const readline = require('node:readline')

class InputHelper extends EventEmitter {
  constructor(log, script = 'tvlauncher-input.py') {
    super()
    this.log = log
    this.script = script
    this.child = null
    this.ready = false
    this.uinput = false
    this.stopped = false
    this.pending = []
  }

  start() {
    const script = path.join(__dirname, '..', 'input', this.script)
    const child = spawn('python3', ['-u', script], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        return this.log(`input helper: ${line}`)
      }
      if (msg.ev === 'ready') {
        this.ready = true
        this.uinput = Boolean(msg.uinput)
        for (const p of this.pending.splice(0)) this.send(p)
      }
      this.emit(msg.ev, msg)
    })
    readline.createInterface({ input: child.stderr }).on('line', (line) => this.log(line))
    child.on('error', (e) => this.log(`input helper failed to start: ${e.message}`))
    child.on('exit', (code) => {
      this.ready = false
      this.child = null
      if (this.stopped) return
      this.log(`${this.script} exited (${code}); restarting`)
      setTimeout(() => this.start(), code === 0 ? 2000 : 10000)
    })
  }

  send(obj) {
    if (!this.child || !this.ready) {
      if (obj.cmd === 'mouse') this.pending = this.pending.filter((p) => p.cmd !== 'mouse')
      this.pending.push(obj)
      return
    }
    this.child.stdin.write(JSON.stringify(obj) + '\n')
  }

  stop() {
    this.stopped = true
    if (this.child) this.child.kill()
  }
}

module.exports = { InputHelper }
