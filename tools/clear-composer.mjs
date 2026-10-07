/**
 * Clear the composer in the desktop instance.
 *
 * DSH's composer is a React-controlled contenteditable: mutating its DOM or
 * dispatching a synthetic `input` event leaves React's state untouched, so the
 * text comes straight back. The only thing that actually edits it is real input,
 * which is what this sends — CDP key events, the same way a keyboard would.
 *
 * Usage: node tools/clear-composer.mjs [--port 9222] [--count 40]
 */
import { CdpSession, findPageTarget, isDshPage, sleep } from './cdp.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const port = Number(flag('port', '9222'))
const count = Number(flag('count', '40'))

const target = await findPageTarget({ port, timeoutMs: 60000, match: isDshPage })
const session = await CdpSession.open(target)
try {
  const before = await session.evaluate(`(() => {
    const el = document.querySelector('textarea,[contenteditable=true]')
    if (!el) return null
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    return (el.value !== undefined ? el.value : el.innerText) || ''
  })()`)

  if (before === null) {
    console.log('no composer found')
  } else {
    for (let i = 0; i < count; i += 1) {
      await session.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
        key: 'Backspace',
        code: 'Backspace'
      })
      await session.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
        key: 'Backspace',
        code: 'Backspace'
      })
      await sleep(20)
    }
    const after = await session.evaluate(`(() => {
      const el = document.querySelector('textarea,[contenteditable=true]')
      return el === null ? '' : ((el.value !== undefined ? el.value : el.innerText) || '')
    })()`)
    console.log(JSON.stringify({ before, after, cleared: after === '' }, null, 2))
  }
} finally {
  session.close()
}
