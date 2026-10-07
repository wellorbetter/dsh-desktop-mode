/**
 * Inject (or remove) the DSH desktop widget layer in the shell's page.
 *
 * The layer is a small script + stylesheet drawn on top of the DSH UI
 * (widgets/desktop-widgets.js|css) configured by config/widgets.json. Two
 * delivery paths are used together:
 *
 *   `persistent` — Page.addScriptToEvaluateOnNewDocument, so the layer also
 *                  appears after any page reload of the desktop shell;
 *   `apply`      — evaluate right now, for instant reloads while editing.
 *
 * `apply` — evaluate right now (hot reload / "widgets on"); the daemon is what
 *           keeps the layer alive across page loads, because a document-start
 *           registration dies with the CDP session that created it.
 * `off`   — disable the live layer and set a flag so a reload does not bring it
 *           back on its own.
 *
 * Usage:
 *   node inject-widgets.mjs --mode apply [--port 9222]   # hot reload / on
 *   node inject-widgets.mjs --mode off   [--port 9222]   # remove + stay off
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CdpSession, findPageTarget, isDshPage } from './cdp.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.dirname(here)
const configPath = path.join(projectRoot, 'config', 'widgets.json')
const scriptPath = path.join(projectRoot, 'widgets', 'desktop-widgets.js')
const stylePath = path.join(projectRoot, 'widgets', 'desktop-widgets.css')

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const port = Number(flag('port', '9222'))
const mode = flag('mode', 'apply')
if (!['apply', 'off', 'resample'].includes(mode)) throw new Error(`unknown mode: ${mode} (apply | off | resample)`)

for (const required of [configPath, scriptPath, stylePath]) {
  if (!fs.existsSync(required)) throw new Error(`missing file: ${required}`)
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const css = fs.readFileSync(stylePath, 'utf8')
const widgetScript = fs.readFileSync(scriptPath, 'utf8')

// `widgets-off` (and "enabled": false) must also survive a page reload, which a
// document-start registration would otherwise undo. The flag can only force the
// layer OFF; clearing it means "follow config/widgets.json".
const FLAG_KEY = 'dsh-desktop-widgets.enabled'
const setFlag = (value) => `try { localStorage.setItem(${JSON.stringify(FLAG_KEY)}, ${JSON.stringify(value)}) } catch (error) {}`

// One self-contained document-start payload: config + css travel with the code
// so the layer never has to fetch anything from the page.
const bootstrap = [
  'try {',
  `  let dshWidgetConfig = ${JSON.stringify(config)};`,
  `  try { if (localStorage.getItem(${JSON.stringify(FLAG_KEY)}) === '0') dshWidgetConfig = Object.assign({}, dshWidgetConfig, { enabled: false }); } catch (error) {}`,
  '  window.__DSH_DESKTOP_WIDGETS_BOOT__ = { config: dshWidgetConfig, css: ' + JSON.stringify(css) + ' };',
  '} catch (error) { console.warn("[dsh-desktop-widgets] boot payload failed", error); }',
  widgetScript
].join('\n')

const target = await findPageTarget({
  port,
  timeoutMs: 60000,
  match: isDshPage
})
const session = await CdpSession.open(target)
try {
  if (mode === 'resample') {
    const result = await session.evaluate("window.__dshDesktopWidgets && window.__dshDesktopWidgets.resample ? window.__dshDesktopWidgets.resample('cli') : null")
    const state = await session.evaluate('window.__dshDesktopWidgets ? window.__dshDesktopWidgets.contrast() : null')
    console.log(JSON.stringify({ mode, requested: Boolean(result), contrast: state }, null, 2))
  } else if (mode === 'off') {
    await session.evaluate(setFlag('0'))
    const result = await session.evaluate(
      'window.__dshDesktopWidgets ? window.__dshDesktopWidgets.disable() : { mounted: false }'
    )
    console.log(JSON.stringify({ mode, state: result ?? null }, null, 2))
  } else {
    await session.evaluate(setFlag('1'))
    await session.evaluate(bootstrap)
    const state = await session.evaluate('window.__dshDesktopWidgets ? window.__dshDesktopWidgets.state() : null')
    console.log(JSON.stringify({ mode, state }, null, 2))
    if (config.enabled && !state?.mounted) {
      console.error('widget layer did not mount')
      process.exitCode = 1
    }
  }
} finally {
  session.close()
}


