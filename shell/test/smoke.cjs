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

console.log('smoke tests passed')
