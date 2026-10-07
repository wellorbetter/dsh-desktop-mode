/**
 * Close the DSH first-run onboarding dialog on the desktop layer.
 *
 * A fresh shell profile has no DeepSeek API key configured, so the page opens
 * with a modal ("添加一个 API Key 开始使用") that covers the desktop every time
 * the layer starts. This tool clicks its dismiss button so the desktop comes up
 * usable; it only ever clicks the explicit "later/skip" button of a dialog that
 * mentions an API key, and reports what it found.
 *
 * Usage:
 *   node dismiss-onboarding.mjs [--port 9222] [--timeout 30000] [--keep]
 *
 * `--keep` reports the dialog without clicking it.
 */
import { CdpSession, findPageTarget, sleep } from './cdp.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const port = Number(flag('port', '9222'))
const timeoutMs = Number(flag('timeout', '30000'))
const keep = args.includes('--keep')

// Only dialogs that talk about an API key are considered, and only their
// dismiss/later buttons are clicked — never "save".
const EXPRESSION = `(() => {
  const DISMISS = /^(稍后配置|稍后|跳过|以后再说|later|skip|not now)$/i
  const KEYWORD = /API\\s*Key|API\\s*密钥|添加一个/i
  const visible = (node) => {
    if (!node) return false
    const rect = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  }
  const dialogs = [...document.querySelectorAll('[role=dialog], [class*=modal], [class*=Modal], [class*=dialog], [class*=Dialog]')]
    .filter(visible)
  const hit = dialogs.find((node) => KEYWORD.test(node.innerText || ''))
  if (!hit) return JSON.stringify({ found: false })
  const buttons = [...hit.querySelectorAll('button')]
  const target = buttons.find((b) => DISMISS.test((b.textContent || '').trim()))
  const labels = buttons.map((b) => (b.textContent || '').trim()).filter(Boolean)
  if (!target) return JSON.stringify({ found: true, clicked: false, labels })
  if (${keep ? 'true' : 'false'}) return JSON.stringify({ found: true, clicked: false, kept: true, labels })
  target.click()
  return JSON.stringify({ found: true, clicked: true, label: (target.textContent || '').trim(), labels })
})()`

const target = await findPageTarget({ port, timeoutMs })
const session = await CdpSession.open(target)
try {
  // The dialog can appear a moment after the SPA mounts.
  const deadline = Date.now() + timeoutMs
  let last = { found: false }
  while (Date.now() < deadline) {
    const raw = await session.evaluate(EXPRESSION)
    last = raw ? JSON.parse(raw) : { found: false }
    if (last.found) break
    await sleep(1000)
  }
  console.log(JSON.stringify(last, null, 2))
  if (last.found && !last.clicked && !keep) process.exitCode = 1
} finally {
  session.close()
}
