// Quick checks that run without Electron or a TV: `npm run check`.
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { parseVdf } = require('../lib/steam.cjs')
const { supportsGamepad } = require('../lib/store.cjs')
const { VALID_ID } = require('../lib/flatpak.cjs')

const acf = parseVdf(`"AppState"
{
	"appid"		"413150"
	"name"		"Stardew Valley"
	"UserConfig" { "language" "english" }
}`)
assert.equal(acf.AppState.appid, '413150')
assert.equal(acf.AppState.name, 'Stardew Valley')
assert.equal(acf.AppState.UserConfig.language, 'english')

const lib = parseVdf(`"libraryfolders" { "0" { "path" "/home/me/.local/share/Steam" "apps" { "413150" "123" } } "1" { "path" "/mnt/games/SteamLibrary" } }`)
assert.equal(lib.libraryfolders['1'].path, '/mnt/games/SteamLibrary')

assert.equal(supportsGamepad({ supports: [{ type: 'control', value: 'gamepad' }] }), true)
assert.equal(supportsGamepad({ supports: null }), false)

assert.ok(VALID_ID.test('tv.plex.PlexHTPC'))
assert.ok(VALID_ID.test('com.moonlight_stream.Moonlight'))
assert.ok(!VALID_ID.test('--help'))
assert.ok(!VALID_ID.test('foo; rm -rf /'))

// listSteamGames against a fake Steam folder
const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-'))
fs.mkdirSync(path.join(fake, '.local/share/Steam/steamapps'), { recursive: true })
fs.writeFileSync(path.join(fake, '.local/share/Steam/steamapps/appmanifest_413150.acf'), '"AppState" { "appid" "413150" "name" "Stardew Valley" }')
fs.writeFileSync(path.join(fake, '.local/share/Steam/steamapps/appmanifest_1493710.acf'), '"AppState" { "appid" "1493710" "name" "Proton Experimental" }')
process.env.HOME = fake
delete require.cache[require.resolve('../lib/system.cjs')]
delete require.cache[require.resolve('../lib/steam.cjs')]
const games = require('../lib/steam.cjs').listSteamGames()
assert.deepEqual(games.map((g) => g.name), ['Stardew Valley'])

// display: the TV's real wlr-randr output (Nov 1) — prefers 1360x768, offers 1080p
const display = require('../lib/display.cjs')
const tvRandr = `DP-3 "LG Electronics LG TV 0x01010101 (DP-3 via HDMI)"
  Make: LG Electronics
  Model: LG TV
  Serial: 0x01010101
  Physical size: 1600x900 mm
  Enabled: yes
  Modes:
    1360x768 px, 60.014999 Hz (preferred, current)
    1920x1080 px, 60.000000 Hz
    1920x1080 px, 60.000000 Hz
    1920x1080 px, 59.939999 Hz
    1920x1080 px, 30.000000 Hz
  Position: 0,0
  Transform: normal
  Scale: 1.000000
  Adaptive Sync: disabled
`
const outs = display.parseOutputs(tvRandr)
assert.equal(outs.length, 1)
assert.equal(outs[0].name, 'DP-3')
assert.equal(outs[0].enabled, true)
assert.equal(outs[0].modes.length, 5)
assert.equal(outs[0].modes[0].current, true)
assert.equal(display.pickMode(outs[0].modes).text, '1920x1080@60.000000Hz')
assert.ok(display.SCALES.includes(display.DEFAULT_SCALE))

// Steam games are found by SteamAppId in their environment
const steamproc = require('../lib/steamproc.cjs')
assert.equal(steamproc.envMatches('HOME=/x\0SteamAppId=204360\0SteamGameId=204360\0', '204360'), true)
assert.equal(steamproc.envMatches('SteamAppId=2043600\0', '204360'), false)
assert.equal(steamproc.envMatches('', '204360'), false)
assert.deepEqual(steamproc.gamePids('0'), [])
assert.deepEqual(steamproc.gamePids('abc'), [])
{
  // a real child process with the variable is found, and quitGame ends it
  const { spawnSync, spawn: sp } = require('node:child_process')
  const child = sp('sleep', ['30'], { env: { ...process.env, SteamAppId: '999999001' } })
  spawnSync('sleep', ['0.2'])
  assert.deepEqual(steamproc.gamePids('999999001'), [child.pid])
  steamproc.quitGame('999999001', 100)
  spawnSync('sleep', ['0.3'])
  assert.deepEqual(steamproc.gamePids('999999001').filter((p) => p === child.pid && !child.killed && child.exitCode === null && child.signalCode === null), [])
}

// OS update progress, from the TV's real rpm-ostree output
const osu = require('../lib/osupdate.cjs')
{
  const p = { totalMB: 0, doneMB: 0, staging: false }
  const lines = [
    'Pulling manifest: ostree-unverified-registry:ghcr.io/skeddles/tv-os:latest',
    'ostree chunk layers already present: 107',
    'ostree chunk layers needed: 21 (912.2 MB)',
    '[1/21] Fetching ostree chunk 2c4d6f8a0b1c3e5 (450.0 MB)...done',
    '[2/21] Fetching ostree chunk 76b8d77920bf2547531 (12.7 MB)...',
  ]
  lines.forEach((l) => osu.parseLine(l, p))
  assert.equal(Math.round(p.totalMB * 10), 9122)
  assert.equal(p.doneMB, 450)
  assert.equal(osu.percentOf(p), 49)
  osu.parseLine('[2/21] Fetching ostree chunk 76b8d77920bf2547531 (850 kB)...done', p)
  assert.equal(p.doneMB, 450.85)
  osu.parseLine('Staging deployment...done', p)
  assert.equal(osu.percentOf(p), 100)
  assert.equal(osu.percentOf({ totalMB: 0, doneMB: 0 }), null)
  // the real output has a no-break space before the unit
  const q = { totalMB: 0, doneMB: 0, staging: false }
  osu.parseLine('ostree chunk layers needed: 21 (912.2\u00a0MB)', q)
  osu.parseLine('[1/21] Fetching ostree chunk 84827d5a6a79c1b1568 (49.6\u00a0MB)...done', q)
  assert.equal(Math.round(q.totalMB * 10), 9122)
  assert.equal(q.doneMB, 49.6)
  osu.parseLine('layers already present: 124; layers needed: 4 (612.1\u00a0MB)', (q.totalMB = 0, q))
  assert.equal(q.totalMB, 612.1)
  const st = osu.summarizeStatus(JSON.stringify({ transaction: null, deployments: [{ staged: true, timestamp: 1793563531 }, { booted: true }] }))
  assert.deepEqual(st, { busy: false, staged: { timestamp: 1793563531 } })
  assert.equal(osu.summarizeStatus(JSON.stringify({ transaction: ['upgrade', 'uupd', '/x'], deployments: [] })).busy, true)
}

// The main process of a Flatpak app (process list as seen on the TV with Chrome)
{
  const { pickMain } = require('../lib/appsupport.cjs')
  const chrome = [
    { pid: 11584, comm: 'bwrap', cmdline: '/usr/bin/bwrap --args 160 -- chrome --kiosk', start: 100 },
    { pid: 11594, comm: 'bwrap', cmdline: '/usr/bin/bwrap --args 160 -- chrome --kiosk', start: 101 },
    { pid: 11595, comm: 'chrome', cmdline: '/app/extra/chrome --kiosk --start-fullscreen https://www.netflix.com/browse', start: 102 },
    { pid: 11639, comm: 'bwrap', cmdline: '/usr/bin/bwrap --args 73 -- /app/bin/zypak-helper child - /app/extra/chrome --type=zygote', start: 103 },
    { pid: 11650, comm: 'chrome', cmdline: '/app/extra/chrome --type=utility --utility-sub-type=network.mojom.NetworkService', start: 104 },
    { pid: 11660, comm: 'chrome', cmdline: '/app/extra/chrome --type=renderer', start: 105 },
  ]
  assert.equal(pickMain(chrome).pid, 11595)
  const firefox = [
    { pid: 20, comm: 'firefox', cmdline: '/app/lib/firefox/firefox -contentproc -childID 1', start: 60 },
    { pid: 10, comm: 'firefox', cmdline: '/app/lib/firefox/firefox --name org.mozilla.firefox', start: 50 },
  ]
  assert.equal(pickMain(firefox).pid, 10)
  assert.equal(pickMain([{ pid: 1, comm: 'bwrap', cmdline: 'bwrap', start: 1 }]), null)
}

console.log('smoke tests passed')
