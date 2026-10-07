/**
 * Keep the DSH desktop widget layer alive across page loads.
 *
 * A `Page.addScriptToEvaluateOnNewDocument` registration only lives as long as
 * the CDP session that created it, so one-shot injection disappears the moment
 * the shell reloads its page (shell retry after a failed load, DSH client HMR,
 * a manual reload). This daemon holds the session open instead:
 *
 *   - registers the document-start payload, so every new document mounts the
 *     layer before the app renders;
 *   - re-applies it after each navigation, and re-attaches if the page target
 *     is replaced;
 *   - watches widgets/desktop-widgets.{js,css} and config/widgets.json and
 *     re-injects when they change (hot reload);
 *   - exits when the loader asks it to (`--once` runs a single pass).
 *
 * Usage: node widgets-daemon.mjs [--port 9222] [--once]
 * Writes nothing to stdout unless it fails; logs go to stderr.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { CdpSession, findPageTarget, isDshPage, sleep } from './cdp.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.dirname(here)
const configPath = path.join(projectRoot, 'config', 'widgets.json')
const scriptPath = path.join(projectRoot, 'widgets', 'desktop-widgets.js')
const stylePath = path.join(projectRoot, 'widgets', 'desktop-widgets.css')
const typingPath = path.join(projectRoot, 'widgets', 'desktop-typing.js')
const inputHelperPath = path.join(projectRoot, 'tools', 'bin', 'dsh-desktop-input.exe')

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const port = Number(flag('port', '9222'))
const once = args.includes('--once')

const FLAG_KEY = 'dsh-desktop-widgets.enabled'

// The wallpaper plugin persists the current wallpaper (settings.id) in its own
// config, port-independently, so the host side gets a wallpaper-change event even
// when the in-page observers see nothing (e.g. a scene wallpaper that keeps the
// same element). The page exposes `window.__dshDesktopWidgets.resample()`.
const wallpaperConfigPath = path.join(homedir(), '.dsh-wallpaper-engine', 'config.json')

function wallpaperFingerprint() {
  // Keyed on the current wallpaper id, NOT on mtime: the plugin rewrites this
  // file for unrelated reasons (playback state, diagnostics) and a real switch is
  // what changes settings.id. mtime is only the fallback when it cannot be read.
  try {
    const raw = fs.readFileSync(wallpaperConfigPath, 'utf8')
    const id = String(JSON.parse(raw)?.settings?.id ?? '')
    if (id !== '') return `id:${id}`
    return `mtime:${fs.statSync(wallpaperConfigPath).mtimeMs}`
  } catch {
    return 'missing'
  }
}

function buildBootstrap() {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  const css = fs.readFileSync(stylePath, 'utf8')
  const widgetScript = fs.readFileSync(scriptPath, 'utf8')
  const typingScript = fs.readFileSync(typingPath, 'utf8')
  return [
    // The launcher owns the desktop layer, so the page is told so directly. It
    // used to ask the shell's bridge, and every bridge call is gated by an IPC
    // trust list that only accepts origin :3080 — the reason this layer needed a
    // patched copy of the app at all.
    'window.__DSH_DESKTOP_MODE__ = true;',
    'try {',
    `  let dshWidgetConfig = ${JSON.stringify(config)};`,
    `  try { if (localStorage.getItem(${JSON.stringify(FLAG_KEY)}) === '0') dshWidgetConfig = Object.assign({}, dshWidgetConfig, { enabled: false }); } catch (error) {}`,
    '  window.__DSH_DESKTOP_WIDGETS_BOOT__ = { config: dshWidgetConfig, css: ' + JSON.stringify(css) + ' };',
    '} catch (error) { console.warn("[dsh-desktop-widgets] boot payload failed", error); }',
    widgetScript,
    // Typing has nothing to do with the widgets and must survive a disabled
    // widget layer, so it is injected separately and never gated by that config.
    'try {',
    ';' + typingScript,
    '} catch (error) { console.warn("[dsh-desktop-typing] install failed", error); }'
  ].join('\n')
}

function fingerprint() {
  // Every file the bootstrap embeds must be in here: this is the outer check the
  // watcher compares first, so a file missing from it can be edited forever
  // without the daemon ever looking at codeFingerprint().
  const parts = [configPath, scriptPath, stylePath, typingPath].map((file) => {
    try {
      const stat = fs.statSync(file)
      return `${stat.mtimeMs}:${stat.size}`
    } catch {
      return 'missing'
    }
  })
  return parts.join('|')
}

// New widget code/styles cannot be injected into the running singleton (its
// methods are captured in the closure that created it), so they are tracked
// separately and trigger a page reload instead of a re-apply. The typing module
// is document-start-only for the same reason: its listeners live per document.
function codeFingerprint() {
  return [scriptPath, stylePath, typingPath].map((file) => {
    try {
      const stat = fs.statSync(file)
      return `${stat.mtimeMs}:${stat.size}`
    } catch {
      return 'missing'
    }
  }).join('|')
}

const log = (message) => console.error(`[widgets-daemon] ${message}`)

// The page asks for a typing transition through a CDP binding rather than a
// poll: the call arrives as an event the moment the user clicks, which is what
// makes "click and type" feel immediate.
const BINDING_NAME = 'dshDesktopTyping'

// True while the shell window is currently outside the desktop layer, so the
// daemon can put it back if it is stopped mid-typing.
let promotedNow = false

/**
 * Run one transition through the fast native helper and resolve its JSON ack.
 * The helper refuses to promote unless the desktop already owns the foreground,
 * so this can never take the keyboard away from another application.
 */
function runInputHelper(action, { force = false, keepBelow = false } = {}) {
  const helperArgs = [action, '--root', projectRoot]
  if (action === 'promote') {
    if (force) helperArgs.push('--force')
    if (keepBelow) helperArgs.push('--keep-below')
  }
  return new Promise((resolve) => {
    execFile(inputHelperPath, helperArgs, { timeout: 15000, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      const lines = String(stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      let parsed = null
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try { parsed = JSON.parse(lines[index]); break } catch { /* not the ack */ }
      }
      if (parsed === null) {
        resolve({
          ok: false,
          mode: 'desktop',
          error: error ? `DSH_INPUT_HELPER_FAILED: ${error.message}` : 'DSH_INPUT_HELPER_OUTPUT_INVALID',
          detail: String(stderr ?? '').slice(0, 200)
        })
        return
      }
      resolve(parsed)
    })
  })
}

let running = true
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { running = false })
}

async function attach() {
  const target = await findPageTarget({
    port,
    timeoutMs: 60000,
    match: isDshPage
  })
  const session = await CdpSession.open(target)
  await session.send('Page.enable')
  await session.send('Runtime.enable')
  // Expose the page->native channel. `addBinding` installs the function on the
  // page's global object; the call shows up here as Runtime.bindingCalled.
  const installBinding = async (reason) => {
    try {
      await session.send('Runtime.addBinding', { name: BINDING_NAME })
      log(`typing binding ready (${reason})`)
    } catch (error) {
      log(`could not install typing binding: ${error.message}`)
    }
  }
  await installBinding('attach')
  // The daemon is only ever started for a deliberate "widgets on" (start /
  // widgets-on), so clear the widgets-off flag before registering: otherwise the
  // document-start payload would honour it and mount the layer disabled.
  await session.evaluate(`try { localStorage.setItem(${JSON.stringify(FLAG_KEY)}, '1') } catch (error) {}`)
  let bootstrap = buildBootstrap()
  let currentFingerprint = fingerprint()
  // The page's singleton can re-apply a new config, but its methods are frozen in
  // the closure that created it: new widget code/styles need a fresh document, so
  // those two files are tracked separately and trigger a page reload.
  let currentCode = codeFingerprint()
  let currentWallpaper = wallpaperFingerprint()

  let registrationId = null
  const register = async () => {
    bootstrap = buildBootstrap()
    currentFingerprint = fingerprint()
    currentCode = codeFingerprint()
    // A stale registration runs first on the next document and creates an
    // instance with the old widget code, which later payloads cannot replace
    // (the singleton's methods are frozen in its closure) — so drop it first.
    if (registrationId) {
      try { await session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: registrationId }) } catch { /* already gone */ }
      registrationId = null
    }
    const registration = await session.send('Page.addScriptToEvaluateOnNewDocument', { source: bootstrap })
    registrationId = registration.identifier
    log(`registered document-start payload (${registration.identifier})`)
  }
  const apply = async (reason) => {
    await session.evaluate(bootstrap)
    log(`applied widget layer (${reason})`)
  }

  await register()
  await apply('attach')

  // Typing transitions run one at a time: a single click can produce both a
  // pointerdown and a focusin, and two overlapping reparents would fight.
  let transitionChain = Promise.resolve()
  let lastTransition = { action: '', at: 0 }
  const handleTransition = (action, payload) => {
    if (action !== 'promote' && action !== 'demote' && action !== 'verify' && action !== 'focus') return
    const now = Date.now()
    if (lastTransition.action === action && now - lastTransition.at < 400) {
      log(`${action} ignored (duplicate within 400ms)`)
      return
    }
    lastTransition = { action, at: now }
    transitionChain = transitionChain.then(async () => {
      // "verify" is a read-back and "focus" is a retry, not transitions: the page
      // asks what is really true so it can never believe a promotion that did not
      // happen, and asks for the keyboard again when the first grab lost a race.
      const result = await runInputHelper(action === 'verify' ? 'status' : action)
      if (action === 'verify') promotedNow = result.onDesktopLayer === false
      else if (action === 'focus') promotedNow = result.foreground === true
      else promotedNow = result.mode === 'promoted' && result.ok === true
      log(`${action} <${payload.reason ?? ''}> ok=${result.ok === true} mode=${result.mode ?? '?'} keyboard=${result.foreground === true || result.keyboard === true} error=${result.error || '-'}`)
      const reported = action === 'verify'
        ? { ...result, kind: 'status' }
        : action === 'focus' ? { ...result, kind: 'focus' } : result
      try {
        await session.evaluate(`window.__dshDesktopTyping && window.__dshDesktopTyping.result(${JSON.stringify(reported)})`)
      } catch (error) {
        log(`could not report the ${action} result to the page: ${error.message}`)
      }
    }).catch((error) => log(`${action} failed: ${error.message}`))
  }
  session.on('Runtime.bindingCalled', (params) => {
    if (params?.name !== BINDING_NAME) return
    let payload = {}
    try { payload = JSON.parse(String(params.payload ?? '{}')) ?? {} } catch { payload = {} }
    handleTransition(String(payload.action ?? ''), payload)
  })

  // Tell the page what is really true as soon as the channel exists. The module
  // asks for this itself, but at document-start the binding may not be installed
  // yet and its retries can expire before the daemon finishes attaching (measured:
  // no report arrived and the page kept onDesktopLayer = null).
  handleTransition('verify', { reason: 'binding-installed' })

  // Re-apply on every navigation: the document-start registration already does
  // this on a fresh session, but re-applying keeps the live page correct even if
  // that registration is dropped (e.g. a new target with a fresh session).
  session.on('Page.frameNavigated', async (params) => {
    if (params?.frame?.parentId) return
    await sleep(1200)
    // Bindings are per document context: re-install before the re-apply so the
    // freshly loaded page can ask for a transition right away.
    await installBinding('navigated')
    try { await apply('navigated') } catch (error) { log(`apply after navigation failed: ${error.message}`) }
  })

  let sessionClosed = false
  session.on('Page.loadEventFired', () => { })
  const closed = new Promise((resolve) => {
    const check = setInterval(() => {
      if (session.closed || !running) {
        clearInterval(check)
        sessionClosed = true
        resolve('closed')
      }
    }, 1000)
  })

  // Host-side wallpaper change: the plugin rewrites its config with the new
  // wallpaper id; ask the page to re-read the wallpaper and re-decide.
  const wallpaperWatcher = setInterval(async () => {
    if (session.closed || !running) return
    const next = wallpaperFingerprint()
    if (next === currentWallpaper) return
    currentWallpaper = next
    try {
      await session.evaluate("window.__dshDesktopWidgets && window.__dshDesktopWidgets.resample && window.__dshDesktopWidgets.resample('plugin-config')")
      log('wallpaper changed on the host side, asked the page to resample')
    } catch (error) {
      log(`wallpaper resample request failed: ${error.message}`)
    }
  }, 3000)

  const watcher = setInterval(async () => {
    if (session.closed || !running) return
    const next = fingerprint()
    if (next === currentFingerprint) return
    const nextCode = codeFingerprint()
    const codeChanged = nextCode !== currentCode
    try {
      currentFingerprint = next
      if (codeChanged) {
        log('widget code/style changed, re-registering and reloading the page')
        await register()
        await session.send('Page.reload', { ignoreCache: true })
        return
      }
      // A config-only change must also refresh the document-start registration:
      // the payload baked into it is what every *later* navigation mounts, so a
      // config applied only to the live page silently reverts on the next reload
      // (measured: the widget layer came back hidden after a reload).
      await register()
      await session.evaluate(buildBootstrap())
      log('config change detected, re-registered and re-applied')
    } catch (error) {
      log(`hot reload failed: ${error.message}`)
    }
  }, 2000)

  await closed
  clearInterval(watcher)
  clearInterval(wallpaperWatcher)
  session.close()
  return sessionClosed
}

// Re-attach forever: the shell may be restarted while the daemon keeps running
// (it is stopped explicitly by the launcher).
let attempt = 0
while (running) {
  try {
    await attach()
    attempt = 0
    if (once) break
    if (!running) break
    log('page target lost, re-attaching…')
    await sleep(2000)
  } catch (error) {
    attempt += 1
    log(`attach failed (${attempt}): ${error.message}`)
    if (once && attempt >= 3) process.exitCode = 1
    if (once && attempt >= 3) break
    await sleep(Math.min(15000, 2000 * attempt))
  }
}

// Never leave the shell parked outside the desktop layer: if the daemon goes
// away while the layer is popped out for typing, put it back where it belongs.
if (promotedNow) {
  log('stopping while the layer was promoted for typing: putting it back')
  const restored = await runInputHelper('demote')
  log(`final demote ok=${restored.ok === true} error=${restored.error || '-'}`)
  promotedNow = false
}
log('stopped')





