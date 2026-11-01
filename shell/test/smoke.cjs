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

console.log('smoke tests passed')
