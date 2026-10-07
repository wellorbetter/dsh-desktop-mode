/**
 * Probe whether the wallpaper behind the widget layer can be sampled in-page,
 * and report the measured luminance per widget region.
 *
 * Read-only: connects over CDP, inspects the wallpaper elements the DSH
 * wallpaper plugin renders (.we-layer), tries to draw them into a 2D canvas and
 * read pixels, and prints the average relative luminance under each widget
 * block. Nothing is modified.
 *
 * Usage: node contrast-probe.mjs [--port 9222]
 */
import { CdpSession, findPageTarget, isDshPage } from './cdp.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const port = Number(flag('port', '9222'))

const EXPRESSION = `(() => {
  const R = { ok: false, notes: [], sources: [], regions: {} }

  // --- 1. what is the wallpaper made of? ---------------------------------
  const layer = document.querySelector('.we-layer') || document.querySelector('[class*=we-][class*=layer]')
  const describe = (node) => {
    if (!node) return null
    const rect = node.getBoundingClientRect()
    return {
      tag: node.tagName.toLowerCase(),
      cls: String(node.className).slice(0, 60),
      size: Math.round(rect.width) + 'x' + Math.round(rect.height),
      src: (node.currentSrc || node.src || '').slice(0, 90),
      sameOriginFrame: node.tagName === 'IFRAME' ? (() => { try { return Boolean(node.contentDocument) } catch { return false } })() : undefined
    }
  }
  R.layer = describe(layer)
  if (layer) {
    R.sources = [...layer.querySelectorAll('img,video,canvas,iframe')].slice(0, 8).map(describe)
    R.scrim = describe(document.querySelector('.we-scrim'))
  }

  // --- 2. pick a paintable source ----------------------------------------
  function pickSource() {
    if (!layer) return null
    const inside = [...layer.querySelectorAll('img,video,canvas')]
    for (const node of inside) {
      const rect = node.getBoundingClientRect()
      if (rect.width > 200 && rect.height > 200) return { node, kind: node.tagName.toLowerCase() }
    }
    const frame = layer.querySelector('iframe')
    if (frame) {
      try {
        const doc = frame.contentDocument
        const inner = doc && doc.querySelector('img,video,canvas')
        if (inner) return { node: inner, kind: 'iframe:' + inner.tagName.toLowerCase() }
      } catch (error) { R.notes.push('iframe not same-origin: ' + error.name) }
    }
    return null
  }

  const picked = pickSource()
  if (!picked) { R.notes.push('no paintable wallpaper source found'); return JSON.stringify(R, null, 1) }
  R.picked = { kind: picked.kind, size: Math.round(picked.node.getBoundingClientRect().width) + 'x' + Math.round(picked.node.getBoundingClientRect().height) }

  // --- 3. draw it into a 2D canvas at viewport scale ---------------------
  const vw = window.innerWidth, vh = window.innerHeight
  const canvas = document.createElement('canvas')
  const SW = 160, SH = Math.max(1, Math.round(160 * vh / vw))
  canvas.width = SW; canvas.height = SH
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  let drew = false
  try {
    const rect = picked.node.getBoundingClientRect()
    // cover-fit: map the element rect onto the viewport-sized sample
    const scale = Math.max(SW / rect.width, SH / rect.height)
    const dw = rect.width * scale, dh = rect.height * scale
    const dx = (SW - dw) / 2, dy = (SH - dh) / 2
    ctx.drawImage(picked.node, dx, dy, dw, dh)
    drew = true
  } catch (error) {
    R.notes.push('drawImage failed: ' + error.name + ' ' + error.message)
  }
  if (!drew) return JSON.stringify(R, null, 1)

  let data = null
  try {
    data = ctx.getImageData(0, 0, SW, SH).data
    R.ok = true
  } catch (error) {
    R.notes.push('getImageData blocked: ' + error.name + ' (tainted canvas)')
    return JSON.stringify(R, null, 1)
  }

  // --- 4. average relative luminance per widget region -------------------
  const lum = (r, g, b) => {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const sample = (selector) => {
    const node = document.querySelector('#dsh-desktop-widgets ' + selector)
    if (!node) return null
    const rect = node.getBoundingClientRect()
    const x0 = Math.max(0, Math.floor(rect.left / vw * SW)), x1 = Math.min(SW, Math.ceil(rect.right / vw * SW))
    const y0 = Math.max(0, Math.floor(rect.top / vh * SH)), y1 = Math.min(SH, Math.ceil(rect.bottom / vh * SH))
    if (x1 <= x0 || y1 <= y0) return null
    let sum = 0, n = 0, min = 1, max = 0
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * SW + x) * 4
      const l = lum(data[i], data[i + 1], data[i + 2])
      sum += l; n += 1; if (l < min) min = l; if (l > max) max = l
    }
    return { avg: +(sum / n).toFixed(3), min: +min.toFixed(3), max: +max.toFixed(3), box: [x0, y0, x1 - x0, y1 - y0] }
  }
  R.regions = {
    clock: sample('.dshw-clock'),
    time: sample('.dshw-time'),
    weekday: sample('.dshw-weekday'),
    caption: sample('.dshw-caption'),
    meta: sample('.dshw-meta'),
    weather: sample('.dshw-weather')
  }
  R.wholeWallpaper = (() => {
    let sum = 0, n = 0
    for (let i = 0; i < data.length; i += 4) { sum += lum(data[i], data[i + 1], data[i + 2]); n += 1 }
    return +(sum / n).toFixed(3)
  })()
  return JSON.stringify(R, null, 1)
})()`

const target = await findPageTarget({ port, timeoutMs: 60000, match: isDshPage })
const session = await CdpSession.open(target)
try {
  const raw = await session.evaluate(EXPRESSION)
  console.log(typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2))
} finally {
  session.close()
}
