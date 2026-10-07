/**
 * Probe what the desktop shell's window is actually rendering.
 *
 * Reports CDP targets and the page's DOM state, optionally evaluates an
 * expression (`--eval`), and otherwise captures the page surface so it can be
 * compared against a real screen capture.
 *
 * Usage:
 *   node cdp-probe.mjs [--port 9222] [--out <png>]
 *   node cdp-probe.mjs [--port 9222] --eval "<expression>"
 */
import fs from 'node:fs'
import path from 'node:path'
import { CdpSession, findPageTarget, isDshPage } from './cdp.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const port = Number(flag('port', '9222'))
const out = flag('out', path.resolve('.evidence', 'page-01.png'))
const custom = flag('eval', '')

const target = await findPageTarget({
  port,
  timeoutMs: 60000,
  // Only ever attach to the DSH page the shell loaded from localhost.
  match: isDshPage
})
console.log(`--- target ---\n${target.type}\t${target.url}`)

const session = await CdpSession.open(target)
try {
  const probe = `(() => {
    const aside = document.querySelector('aside, nav, [class*=sidebar], [class*=Sidebar]')
    const composer = document.querySelector('textarea, [contenteditable=true], [class*=composer], [class*=Composer]')
    return JSON.stringify({
      href: location.href,
      title: document.title,
      readyState: document.readyState,
      rootChildren: document.querySelector('#root')?.childElementCount ?? -1,
      hasSidebar: Boolean(aside),
      hasComposer: Boolean(composer),
      newSession: Boolean(document.querySelector('[class*="composerHero"]')),
      widgets: window.__dshDesktopWidgets ? window.__dshDesktopWidgets.state() : null,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      htmlClass: document.documentElement.className,
      bodyClass: document.body.className,
      viewport: [innerWidth, innerHeight],
      visibility: document.visibilityState,
      bridge: Boolean(window.desktopWindow)
    }, null, 2)
  })()`

  console.log('--- page state ---')
  console.log(await session.evaluate(probe) ?? '(no value)')

  if (custom) {
    console.log('--- eval ---')
    const result = await session.evaluate(custom)
    console.log(typeof result === 'string' ? result : JSON.stringify(result ?? null, null, 2))
  } else if (args.includes('--reload')) {
    // Reload the shell page and report what the document-start registration
    // produced, which is how widget persistence across loads is verified.
    await session.send('Page.enable')
    await session.send('Page.reload', { ignoreCache: true })
    await new Promise((resolve) => setTimeout(resolve, 6000))
    const state = await session.evaluate('window.__dshDesktopWidgets ? JSON.stringify(window.__dshDesktopWidgets.state()) : "no widget layer"')
    console.log('--- after reload ---')
    console.log(state ?? '(no value)')
  } else {
    const shot = await session.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
    console.log(`--- page screenshot -> ${out} ---`)
  }
} finally {
  session.close()
}

