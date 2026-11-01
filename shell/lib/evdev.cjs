// Watches game controllers for the Xbox (Guide) button, even while another app
// is in front. Reads Linux input devices directly; the logged-in user is allowed
// to read controllers through systemd's "uaccess" rule. If a device can't be
// opened, this quietly does nothing (web layers have their own fallback).
//
// Not yet verified on the TV: confirm in Phase 3 that pressing the Xbox button
// while Plex or Chrome is open brings you home.

const fs = require('node:fs')
const path = require('node:path')

const EV_KEY = 1
const BTN_MODE = 0x13c // the Xbox / Guide button
const EVENT_SIZE = 24 // struct input_event on 64-bit Linux

function isJoystick(eventName) {
  try {
    const dev = fs.readFileSync(`/sys/class/input/${eventName}/dev`, 'utf8').trim() // "13:68"
    const data = fs.readFileSync(`/run/udev/data/c${dev}`, 'utf8')
    return /^E:ID_INPUT_JOYSTICK=1$/m.test(data)
  } catch {
    return false
  }
}

function watchGuideButton(onPress) {
  const open = new Map() // eventName -> stream

  function attach(name) {
    const stream = fs.createReadStream(path.join('/dev/input', name), { highWaterMark: EVENT_SIZE * 64 })
    let buf = Buffer.alloc(0)
    stream.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      while (buf.length >= EVENT_SIZE) {
        const type = buf.readUInt16LE(16)
        const code = buf.readUInt16LE(18)
        const value = buf.readInt32LE(20)
        if (type === EV_KEY && code === BTN_MODE && value === 1) onPress()
        buf = buf.subarray(EVENT_SIZE)
      }
    })
    const drop = () => {
      open.delete(name)
      stream.destroy()
    }
    stream.on('error', drop)
    stream.on('close', drop)
    open.set(name, stream)
  }

  function scan() {
    let names = []
    try {
      names = fs.readdirSync('/dev/input').filter((n) => /^event\d+$/.test(n))
    } catch {
      return
    }
    for (const n of names) if (!open.has(n) && isJoystick(n)) attach(n)
  }

  scan()
  const timer = setInterval(scan, 5000) // pick up controllers plugged in later
  return () => {
    clearInterval(timer)
    for (const s of open.values()) s.destroy()
  }
}

module.exports = { watchGuideButton, isJoystick }
