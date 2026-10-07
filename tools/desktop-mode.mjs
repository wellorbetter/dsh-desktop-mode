/**
 * Drive the DSH desktop shell's desktop mode over the Chrome DevTools Protocol.
 *
 * LEGACY, and no longer used by the launcher: the desktop layer is pinned,
 * released and focused by tools/native/dsh-desktop-input.cs, because every call
 * into the shell's own desktop mode is gated by an IPC trust list that only
 * accepts origin :3080 (this layer is served from :3081) and its generated
 * PowerShell cannot even find Progman ($null reaches FindWindow as ""). Using
 * this file is what forced a patched copy of the app.
 *
 * Only the `page` probe is still used by the tools (it injects nothing and needs
 * no cooperation from the app). The bridge commands below only work against a
 * patched shell and are kept for diagnostics and comparison.
 *
 * Usage:
 *   node desktop-mode.mjs page    [--port 9222]
 *   node desktop-mode.mjs status  [--port 9222]   # patched shell only
 *   node desktop-mode.mjs enable  [--port 9222]   # patched shell only
 *   node desktop-mode.mjs disable [--port 9222]   # patched shell only
 *   node desktop-mode.mjs focus   [--port 9222]   # patched shell only
 *   node desktop-mode.mjs icons <visible|hidden>  # patched shell only
 */
import { CdpSession, findPageTarget, isDshPage, sleep } from './cdp.mjs'

const args = process.argv.slice(2)
const command = args[0] ?? 'status'
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const port = Number(flag('port', '9222'))
const timeoutMs = Number(flag('timeout', '90000'))

const PAGE_PROBE = `(() => JSON.stringify({
  href: location.href,
  title: document.title,
  readyState: document.readyState,
  rootChildren: document.querySelector('#root')?.childElementCount ?? -1,
  hasSidebar: Boolean(document.querySelector('aside, nav, [class*=sidebar], [class*=Sidebar]')),
  hasComposer: Boolean(document.querySelector('textarea, [contenteditable=true], [class*=composer], [class*=Composer]')),
  newSession: Boolean(document.querySelector('[class*="composerHero"]')),
  widgets: window.__dshDesktopWidgets ? window.__dshDesktopWidgets.state() : null,
  bridge: Boolean(window.desktopWindow)
}))()`

const EXPRESSIONS = {
  enable: 'window.desktopWindow.setDesktopMode({ enabled: true, interactive: true })',
  disable: 'window.desktopWindow.setDesktopMode({ enabled: false })',
  status: 'window.desktopWindow.getDesktopModeStatus()',
  focus: 'window.desktopWindow.requestDesktopKeyboardFocus()',
  page: PAGE_PROBE,
  'icons-visible': 'window.desktopWindow.setDesktopIconsVisible(true)',
  'icons-hidden': 'window.desktopWindow.setDesktopIconsVisible(false)'
}

// The shell *returns* { ok:false, visible, error:'DSH_DESKTOP_ICON_VISIBILITY_FAILED' }
// instead of throwing, and it reports that error whenever ShowWindow's return
// value (the PREVIOUS visibility state) is 0 — i.e. on every re-show, and also
// whenever the requested state already matches. Ask probeDesktopIcons() for the
// real state instead of trusting the flag, and report both.
const iconsExpression = (visible) => `(async () => {
  let setResult = null
  let setError = ''
  try { setResult = await window.desktopWindow.setDesktopIconsVisible(${visible}) }
  catch (error) { setError = String((error && error.message) || error) }
  let probe = null
  try { probe = await window.desktopWindow.probeDesktopIcons() } catch (error) { probe = { error: String(error) } }
  return { requested: ${visible}, setResult, setError, probe }
})()`

let expression
if (command === 'icons') {
  expression = iconsExpression(args[1] === 'hidden' ? 'false' : 'true')
} else {
  expression = EXPRESSIONS[command]
}
if (!expression) {
  console.error(`unknown command: ${command} (enable | disable | status | page | focus | icons <visible|hidden>)`)
  process.exit(2)
}

const target = await findPageTarget({
  port,
  timeoutMs,
  // Only ever attach to the DSH page the shell loaded from localhost.
  match: isDshPage
})
const session = await CdpSession.open(target)
try {
  // The bridge object is installed by the preload before any page script runs,
  // but the renderer may still be booting plugin bundles; wait for the bridge.
  const deadline = Date.now() + timeoutMs
  let bridgeReady = false
  while (Date.now() < deadline) {
    const probe = await session
      .evaluate('typeof window.desktopWindow === "object" && window.desktopWindow.isDesktop === true')
      .catch(() => false)
    if (probe === true) { bridgeReady = true; break }
    await sleep(1000)
  }
  if (!bridgeReady) throw new Error('window.desktopWindow bridge never became available')

  // enable can legitimately block while the shell re-parents the window, so it
  // gets the caller's budget rather than the 30s default.
  const value = await session.evaluate(expression, { timeoutMs: Math.max(30000, timeoutMs) })
  // The `page` probe builds its own JSON string so it can return several fields
  // from one expression; unwrap it before printing.
  let printable = value
  if (command === 'page' && typeof value === 'string') {
    try { printable = JSON.parse(value) } catch { printable = { raw: value } }
  }
  console.log(JSON.stringify(printable ?? null, null, 2))
} finally {
  session.close()
}


