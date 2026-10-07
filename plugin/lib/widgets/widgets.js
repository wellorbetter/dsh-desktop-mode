/**
 * DSH desktop widget layer.
 *
 * Injected into the DSH page that the desktop shell renders on the Windows
 * desktop layer (see tools/inject-widgets.mjs). Draws the pieces the reference
 * desktop has that DSH itself does not: a large clock with date/weekday, a
 * weather badge, a hand-written caption, the theme name and a live fps readout.
 *
 * Contract with the injector
 * --------------------------
 *   window.__DSH_DESKTOP_WIDGETS_BOOT__ = { config, css }
 * is set right before this file runs, both for the live page and for every
 * future document (Page.addScriptToEvaluateOnNewDocument). Re-applying with a
 * new config is safe: the singleton is reused and only re-rendered.
 *
 * Rules kept deliberately: everything is pointer-events:none so the DSH UI
 * keeps working, every DOM write is wrapped, and nothing throws into the page.
 */
( () => {
  'use strict'

  let boot = window.__DSH_DESKTOP_WIDGETS_BOOT__ || {}
  const ROOT_ID = 'dsh-desktop-widgets'
  const STYLE_ID = 'dsh-desktop-widgets-style'

  // Re-injecting the same script (every `widgets-reload`, and every page load
  // after a document-start registration) must reuse this instance: a second
  // copy would leave the previous interval/rAF chain running forever. `reset`
  // lets the new payload re-configure the existing instance instead.
  const existing = window.__dshDesktopWidgets
  if (existing && typeof existing.reset === 'function') {
    try {
      existing.reset(boot)
    } catch (error) {
      console.warn('[dsh-desktop-widgets] reset failed:', error)
    }
    return
  }

  const DEFAULTS = {
    enabled: true,
    onlyOnNewSession: true,
    clock: {
      enabled: true,
      anchor: { left: '14.6%', top: '9.5%' },
      temperature: '',
      hour12: false,
      showSeconds: false,
      showDate: true,
      showWeekday: true,
      weekdayLocale: 'en',
      scale: 1,
      color: '#eef3f8',
      // Legibility over an arbitrary wallpaper: font weight for the big glyphs,
      // outline width in px, shadow strength, and a soft dark pool behind the
      // block (0 disables it).
      weight: 300,
      stroke: 1,
      shadow: 'strong',
      backdrop: 0.28
    },
    caption: { enabled: true, text: '', sub: '' },
    meta: { enabled: true, anchor: { right: '3.4%', top: '9.5%' }, showFps: true, themeName: '', themeAlias: '' },
    weather: { enabled: true, anchor: { right: '2.6%', top: '1.6%' }, glyph: '雪', temperature: '' },
    character: { enabled: false, src: '', anchor: { right: '1.6%', bottom: '0.8%' }, height: '30%' },
    /**
     * Text colour is normally decided from the wallpaper under the text:
     * dark wallpaper -> light text, bright wallpaper -> dark text with a light
     * halo. `mode` can pin it (light/dark mean "text colour", i.e. `dark` =
     * light text on a dark wallpaper) when the sampler cannot read the source.
     */
    contrast: {
      enabled: true,
      mode: 'auto',
      intervalMs: 5000,
      darkBelow: 0.45,
      lightAbove: 0.55,
      switchAfter: 3,
      sampleWidth: 160
    }
  }

  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  const merge = (base, override) => {
    const out = { ...base }
    if (!isObject(override)) return out
    for (const [key, value] of Object.entries(override)) {
      out[key] = isObject(value) && isObject(base[key]) ? merge(base[key], value) : value
    }
    return out
  }

  const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
  const WEEKDAYS_EN = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']
  const WEEKDAYS_ZH = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

  const pad = (value) => String(value).padStart(2, '0')

  /**
   * The widgets belong to the empty "new session" surface. In a chat they would
   * sit on top of the transcript, so the decision is: a hero (centred) composer
   * means new session; a transcript-ish container or a non-hero composer means a
   * chat; only when neither exists (booting, or another view) fall back to the
   * route.
   *
   * The class names here are DSH's private CSS-module names, so they can change
   * with a front-end release. If the widgets ever stop appearing, set
   * "onlyOnNewSession": false in config/widgets.json — that bypasses the gate
   * entirely — and check `status` (it prints widgetsVisible).
   */
  function isNewSessionSurface() {
    try {
      if (document.querySelector('[class*="composerHero"]') !== null) return true
      if (document.querySelector('[class*="message"], [class*="Message"], [class*="transcript"], [class*="conversationTurn"]') !== null) return false
      if (document.querySelector('textarea, [contenteditable=true]') !== null) return false
      const hash = location.hash || ''
      return hash === '' || hash === '#' || hash === '#/'
    } catch {
      return true
    }
  }

  /** Only load artwork we can reason about; never let a config value smuggle a
   *  same-origin credentialed GET through a scheme we did not intend. */
  function safeImageSource(value) {
    const source = String(value ?? '').trim()
    if (source === '') return ''
    if (/^(https?:\/\/|data:image\/|\/|\.\/)/i.test(source)) return source
    return ''
  }

  function anchorStyle(node, anchor) {
    if (!anchor) return
    for (const side of ['left', 'right', 'top', 'bottom']) {
      if (typeof anchor[side] === 'string' && anchor[side] !== '') node.style[side] = anchor[side]
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }

  function escapeForCssUrl(value) {
    return String(value).replace(/["\\\n\r]/g, (ch) => (ch === '\n' || ch === '\r' ? '' : `\\${ch}`))
  }

  const SHADOWS = {
    strong: '0 1px 2px rgba(4, 10, 20, 0.9), 0 2px 12px rgba(4, 10, 20, 0.75), 0 0 30px rgba(4, 10, 20, 0.5)',
    soft: '0 2px 16px rgba(8, 16, 28, 0.55), 0 1px 2px rgba(8, 16, 28, 0.6)',
    none: 'none'
  }

  /** Push the legibility knobs onto the layer root, where the CSS reads them. */
  function applyLegibility(root, config) {
    const clock = config?.clock ?? {}
    const weight = Number(clock.weight)
    if (Number.isFinite(weight) && weight > 0) root.style.setProperty('--dshw-time-weight', String(weight))
    const stroke = Number(clock.stroke)
    if (Number.isFinite(stroke) && stroke >= 0) root.style.setProperty('--dshw-stroke', `${stroke}px`)
    root.style.setProperty('--dshw-shadow', SHADOWS[String(clock.shadow ?? 'strong')] ?? SHADOWS.strong)
    const backdrop = Number(clock.backdrop)
    if (Number.isFinite(backdrop) && backdrop > 0) root.style.setProperty('--dshw-backdrop', String(backdrop))
  }

  const state = {
    config: merge(DEFAULTS, boot.config),
    root: null,
    // How many times the layer has been built. `instanceId` identifies the module
    // (it never changes), so this is the only observable that says "the layer was
    // rebuilt" — the launcher's reload check and the settings page both need it.
    renders: 0,
    nodes: {},
    timer: null,
    rafId: null,
    fpsTimer: null,
    frames: 0,
    fpsWindowStart: 0,
    observer: null,
    contrastTimer: null,
    contrastSample: null,
    wallpaperWatched: false,
    layerObserver: null,
    bodyObserver: null,
    retryTimer: null,
    lastTrigger: null,
    lastResampleAt: null,
    // Each text block adapts on its own: a wallpaper can be bright where the
    // clock sits and dark where the fps readout sits.
    palettes: {},
    pending: {}
  }

  /** Text blocks that adapt independently, with the sampled regions each uses. */
  const CONTRAST_BLOCKS = {
    clock: { selector: '.dshw-clock', regions: ['time', 'weekday', 'caption'] },
    meta: { selector: '.dshw-meta', regions: ['fps'] }
  }

  // ---------------------------------------------------------- contrast -----
  // The wallpaper is drawn inside this page by the DSH wallpaper plugin
  // (.we-layer holds an <img>/<video>/<canvas>, usually same-origin), so the
  // layer can read the pixels under its own text and pick a palette from the
  // measured luminance instead of guessing.

  function relativeLuminance(r, g, b) {
    const channel = (value) => {
      const c = value / 255
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  }

  function findWallpaperSource() {
    const layer = document.querySelector('.we-layer') || document.querySelector('[class*="we-"][class*="layer"]')
    if (!layer) return null
    for (const node of layer.querySelectorAll('img, video, canvas')) {
      const rect = node.getBoundingClientRect()
      if (rect.width > 200 && rect.height > 200 && rect.bottom > 0 && rect.right > 0) return { node, rect }
    }
    const frame = layer.querySelector('iframe')
    if (frame) {
      try {
        const inner = frame.contentDocument?.querySelector('img, video, canvas')
        if (inner) return { node: inner, rect: inner.getBoundingClientRect() }
      } catch {
        // cross-origin frame: cannot sample
      }
    }
    return null
  }

  function sampleWallpaper(config) {
    const source = findWallpaperSource()
    if (!source) return { ok: false, reason: 'no-wallpaper-source' }
    const viewportWidth = Math.max(1, window.innerWidth)
    const viewportHeight = Math.max(1, window.innerHeight)
    const width = Math.max(48, Math.min(320, Number(config?.sampleWidth) || 160))
    const height = Math.max(1, Math.round((width * viewportHeight) / viewportWidth))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return { ok: false, reason: 'no-2d-context' }
    try {
      const scale = Math.max(width / source.rect.width, height / source.rect.height)
      const drawnWidth = source.rect.width * scale
      const drawnHeight = source.rect.height * scale
      context.drawImage(source.node, (width - drawnWidth) / 2, (height - drawnHeight) / 2, drawnWidth, drawnHeight)
    } catch (error) {
      return { ok: false, reason: 'draw-failed', detail: String(error?.name || error) }
    }
    let pixels
    try {
      pixels = context.getImageData(0, 0, width, height).data
    } catch (error) {
      return { ok: false, reason: 'read-blocked', detail: String(error?.name || error) }
    }

    // Average the wallpaper under each text node, not the block's empty gaps.
    const regionLuminance = (selector) => {
      const node = document.querySelector(`#${ROOT_ID} ${selector}`)
      if (!node) return null
      const rect = node.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return null
      const x0 = Math.max(0, Math.floor((rect.left / viewportWidth) * width))
      const x1 = Math.min(width, Math.ceil((rect.right / viewportWidth) * width))
      const y0 = Math.max(0, Math.floor((rect.top / viewportHeight) * height))
      const y1 = Math.min(height, Math.ceil((rect.bottom / viewportHeight) * height))
      if (x1 <= x0 || y1 <= y0) return null
      let sum = 0
      let count = 0
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const index = (y * width + x) * 4
          sum += relativeLuminance(pixels[index], pixels[index + 1], pixels[index + 2])
          count += 1
        }
      }
      return count > 0 ? sum / count : null
    }

    const regions = {}
    for (const [key, selector] of [['time', '.dshw-time'], ['weekday', '.dshw-weekday'], ['caption', '.dshw-caption'], ['fps', '.dshw-fps']]) {
      const value = regionLuminance(selector)
      if (value !== null) regions[key] = Math.round(value * 1000) / 1000
    }
    const values = Object.values(regions)
    if (values.length === 0) return { ok: false, reason: 'no-text-regions' }
    const round = (value) => Math.round(value * 1000) / 1000
    return {
      ok: true,
      source: source.node.tagName.toLowerCase(),
      regions,
      average: round(values.reduce((a, b) => a + b, 0) / values.length),
      brightest: round(Math.max(...values)),
      darkest: round(Math.min(...values))
    }
  }

  /** Light text needs the *brightest* text area to still be dark, and dark text
   *  needs the *darkest* area to already be bright; in between the outline and
   *  veil carry the contrast, so the palette stays as it is. */
  function decidePalette(sample, config) {
    if (!sample?.ok) return 'ambiguous'
    const darkBelow = Number(config?.contrast?.darkBelow ?? 0.45)
    const lightAbove = Number(config?.contrast?.lightAbove ?? 0.55)
    if (sample.brightest <= darkBelow) return 'dark'
    if (sample.darkest >= lightAbove) return 'light'
    return 'ambiguous'
  }

  /** Write one palette onto a block node; the CSS vars inherit into its text. */
  function applyPaletteTo(node, decision) {
    if (!node) return
    const strength = String(state.config.clock?.shadow ?? 'strong')
    if (decision === 'light') {
      // Bright wallpaper under this block -> dark text with a light halo/pool.
      node.style.setProperty('--dshw-fg', '#0d1117')
      node.style.setProperty('--dshw-stroke-color', 'rgba(255, 255, 255, 0.85)')
      node.style.setProperty('--dshw-backdrop-color', '255, 255, 255')
      node.style.setProperty('--dshw-shadow', '0 1px 2px rgba(255, 255, 255, 0.9), 0 2px 10px rgba(255, 255, 255, 0.6), 0 0 26px rgba(255, 255, 255, 0.4)')
    } else {
      node.style.setProperty('--dshw-fg', '#eef3f8')
      node.style.setProperty('--dshw-stroke-color', 'rgba(6, 12, 22, 0.55)')
      node.style.setProperty('--dshw-backdrop-color', '6, 12, 22')
      node.style.setProperty('--dshw-shadow', SHADOWS[strength] ?? SHADOWS.strong)
    }
  }

  function blockNode(key) {
    const spec = CONTRAST_BLOCKS[key]
    return spec ? document.querySelector(`#${ROOT_ID} ${spec.selector}`) : null
  }

  /** Worst case over the regions belonging to one block. */
  function extremesFor(key, sample) {
    const spec = CONTRAST_BLOCKS[key]
    if (!spec || !sample?.ok) return null
    const values = spec.regions.map((region) => sample.regions?.[region]).filter((value) => typeof value === 'number')
    if (values.length === 0) return null
    return { brightest: Math.max(...values), darkest: Math.min(...values) }
  }

  function decideFromExtremes(extremes, config) {
    if (!extremes) return 'ambiguous'
    const darkBelow = Number(config?.contrast?.darkBelow ?? 0.45)
    const lightAbove = Number(config?.contrast?.lightAbove ?? 0.55)
    if (extremes.brightest <= darkBelow) return 'dark'
    if (extremes.darkest >= lightAbove) return 'light'
    return 'ambiguous'
  }

  function refreshContrast() {
    const config = state.config
    const settings = config.contrast ?? {}
    if (!settings.enabled || !state.root || state.root.hidden) return
    // An explicit clock colour means fully manual: never touch it.
    if (typeof state.config.clock?.color === 'string' && state.config.clock.color.trim() !== '') return

    const mode = String(settings.mode ?? 'auto')

    if (mode === 'light' || mode === 'dark') {
      for (const key of Object.keys(CONTRAST_BLOCKS)) applyPaletteTo(blockNode(key), mode)
      return
    }

    const sample = sampleWallpaper(settings)
    state.contrastSample = { at: Date.now(), ...sample }

    for (const key of Object.keys(CONTRAST_BLOCKS)) {
      const node = blockNode(key)
      if (!node) continue
      const decision = decideFromExtremes(extremesFor(key, sample), config)
      if (decision === 'ambiguous') continue
      if (decision === state.palettes[key]) {
        state.pending[key] = null
        continue
      }
      // Hysteresis per block: a video wallpaper changes brightness per frame, so
      // a switch needs several consecutive agreeing samples.
      const entry = state.pending[key]
      if (entry && entry.decision === decision) entry.count += 1
      else state.pending[key] = { decision, count: 1 }
      const needed = Math.max(1, Number(settings.switchAfter) || 3)
      if ((state.pending[key]?.count ?? 0) >= needed) {
        applyPaletteTo(node, decision)
        state.palettes[key] = decision
        state.pending[key] = null
      }
    }
  }
  /**
   * Wallpaper switches are events, not something to poll for: the plugin swaps
   * the media element inside `.we-layer`, changes its src, and marks the current
   * wallpaper on <body> with data-we-* attributes. Watch those, debounce, and
   * re-sample. The interval below is only a slow safety net.
   */
  function scheduleResample(reason, delay = 400) {
    state.lastTrigger = reason
    if (state.resampleTimer) window.clearTimeout(state.resampleTimer)
    state.resampleTimer = window.setTimeout(() => {
      state.resampleTimer = null
      try {
        refreshContrast()
        state.lastResampleAt = Date.now()
      } catch { /* ignore */ }
    }, delay)
  }

  function attachWallpaperListeners() {
    const layer = document.querySelector('.we-layer')
    if (!layer) return
    if (state.layerObserver) return
    try {
      state.layerObserver = new MutationObserver(() => scheduleResample('layer-mutation'))
      state.layerObserver.observe(layer, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'class', 'style']
      })
    } catch { state.layerObserver = null }
    for (const node of layer.querySelectorAll('video, img')) {
      if (node.dataset.dshwWatched === '1') continue
      node.dataset.dshwWatched = '1'
      node.addEventListener('loadstart', () => scheduleResample('media-loadstart'))
      node.addEventListener('loadeddata', () => scheduleResample('media-loadeddata'))
      node.addEventListener('seeked', () => scheduleResample('media-seeked'), { passive: true })
    }
  }

  function installWallpaperWatchers() {
    if (state.wallpaperWatched) return
    state.wallpaperWatched = true
    try {
      state.bodyObserver = new MutationObserver(() => scheduleResample('body-attributes'))
      state.bodyObserver.observe(document.body || document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'data-we-wallpaper', 'data-we-adapter', 'data-we-mica']
      })
    } catch { state.bodyObserver = null }
    attachWallpaperListeners()
    // A switch replaces the media element, so re-attach until it is seen.
    state.retryTimer = window.setInterval(attachWallpaperListeners, 5000)
  }

  function teardownWallpaperWatchers() {
    if (state.layerObserver) state.layerObserver.disconnect()
    if (state.bodyObserver) state.bodyObserver.disconnect()
    if (state.retryTimer) window.clearInterval(state.retryTimer)
    if (state.resampleTimer) window.clearTimeout(state.resampleTimer)
    state.layerObserver = null
    state.bodyObserver = null
    state.retryTimer = null
    state.resampleTimer = null
    state.wallpaperWatched = false
  }

  function startContrast() {
    stopContrast()
    const settings = state.config.contrast ?? {}
    if (!settings.enabled) return
    try { refreshContrast() } catch { /* sampling must never break the layer */ }
    if (settings.watchWallpaper !== false) installWallpaperWatchers()
    const mode = String(settings.mode ?? 'auto')
    if (mode !== 'auto') return
    // Safety net only: 30s by default, events do the real work.
    const interval = Math.max(5000, Number(settings.intervalMs) || 30000)
    state.contrastTimer = window.setInterval(() => {
      try { refreshContrast() } catch { /* ignore */ }
    }, interval)
  }

  function stopContrast() {
    if (state.contrastTimer) window.clearInterval(state.contrastTimer)
    state.contrastTimer = null
    teardownWallpaperWatchers()
  }

  function ensureStyle(css) {
    if (!css) return
    let style = document.getElementById(STYLE_ID)
    if (!style) {
      style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = css
      ;(document.head || document.documentElement).appendChild(style)
    } else if (style.textContent !== css) {
      style.textContent = css
    }
  }

  function render() {
    const config = state.config
    if (!config.enabled) return remove()
    state.renders += 1

    ensureStyle(boot.css)

    let root = document.getElementById(ROOT_ID)
    if (!root) {
      root = el('div', 'dshw-root')
      root.id = ROOT_ID
      ;(document.body || document.documentElement).appendChild(root)
    }
    state.root = root
    root.textContent = ''
    applyLegibility(root, config)
    const nodes = {}
    state.nodes = nodes

    // ---------------------------------------------------------- clock -----
    if (config.clock.enabled) {
      const clock = el('div', 'dshw-clock dshw-outlined')
      anchorStyle(clock, config.clock.anchor)
      // An explicit colour wins; empty means "decide from the wallpaper".
      if (typeof config.clock.color === 'string' && config.clock.color.trim() !== '') {
        root.style.color = config.clock.color
      }
      if (Number(config.clock.scale) > 0 && Number(config.clock.scale) !== 1) {
        clock.style.transform = `scale(${Number(config.clock.scale)})`
        clock.style.transformOrigin = 'left top'
      }
      if (Number(config.clock.backdrop) > 0) clock.appendChild(el('div', 'dshw-clock-veil'))
      const temperature = config.clock.temperature || config.weather.temperature
      if (temperature) {
        nodes.temp = el('div', 'dshw-temp', temperature)
        clock.appendChild(nodes.temp)
      }
      nodes.time = el('div', 'dshw-time', '--:--')
      clock.appendChild(nodes.time)
      if (config.clock.showDate) {
        nodes.date = el('div', 'dshw-date', '')
        clock.appendChild(nodes.date)
      }
      if (config.clock.showWeekday) {
        nodes.weekday = el('div', 'dshw-weekday', '')
        clock.appendChild(nodes.weekday)
      }
      if (config.caption.enabled && (config.caption.text || config.caption.sub)) {
        const caption = el('div', 'dshw-caption')
        if (config.caption.text) caption.appendChild(el('span', 'dshw-caption-text', config.caption.text))
        if (config.caption.sub) caption.appendChild(el('span', 'dshw-caption-sub', config.caption.sub))
        clock.appendChild(caption)
      }
      root.appendChild(clock)
      updateClock()
    }

    // ----------------------------------------------------------- meta -----
    if (config.meta.enabled) {
      const meta = el('div', 'dshw-meta dshw-outlined')
      anchorStyle(meta, config.meta.anchor)
      if (config.meta.showFps) {
        nodes.fps = el('div', 'dshw-fps', 'fps: --')
        meta.appendChild(nodes.fps)
      }
      if (config.meta.themeName) meta.appendChild(el('div', 'dshw-theme-name', config.meta.themeName))
      if (config.meta.themeAlias) meta.appendChild(el('div', 'dshw-theme-alias', config.meta.themeAlias))
      if (meta.childElementCount > 0) root.appendChild(meta)
    }

    // -------------------------------------------------------- weather -----
    if (config.weather.enabled && config.weather.glyph) {
      const badge = el('div', 'dshw-weather', config.weather.glyph)
      anchorStyle(badge, config.weather.anchor)
      root.appendChild(badge)
    }

    // ------------------------------------------------------ character -----
    if (config.character.enabled) {
      const src = safeImageSource(config.character.src)
      if (src) {
        const box = el('div', 'dshw-character')
        anchorStyle(box, config.character.anchor)
        if (config.character.height) box.style.height = config.character.height
        const img = document.createElement('img')
        img.src = src
        img.alt = ''
        img.draggable = false
        img.onerror = () => { box.style.display = 'none' }
        box.appendChild(img)
        root.appendChild(box)
      }
    }

    // Manual colour (config.clock.color) beats the adaptive palette everywhere.
    const manualColor = typeof config.clock.color === 'string' ? config.clock.color.trim() : ''
    if (manualColor !== '') {
      for (const key of Object.keys(CONTRAST_BLOCKS)) {
        const node = blockNode(key)
        if (node) node.style.color = manualColor
      }
    }

    applyVisibility()
    startTicking()
    startContrast()
  }

  function updateClock() {
    const { nodes, config } = state
    if (!nodes.time) return
    const now = new Date()
    const hour24 = now.getHours()
    let timeText
    if (config.clock.hour12) {
      const suffix = hour24 < 12 ? 'AM' : 'PM'
      const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12
      timeText = `${hour12}:${pad(now.getMinutes())}`
      if (config.clock.showSeconds) timeText += `:${pad(now.getSeconds())}`
      timeText += ` ${suffix}`
    } else {
      timeText = `${pad(hour24)}:${pad(now.getMinutes())}`
      if (config.clock.showSeconds) timeText += `:${pad(now.getSeconds())}`
    }
    nodes.time.textContent = timeText
    if (nodes.date) nodes.date.textContent = `${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`
    if (nodes.weekday) {
      nodes.weekday.textContent = config.clock.weekdayLocale === 'zh'
        ? WEEKDAYS_ZH[now.getDay()]
        : WEEKDAYS_EN[now.getDay()]
    }
  }

  function measureFrame() {
    state.frames += 1
    state.rafId = window.requestAnimationFrame(measureFrame)
  }

  function updateFps() {
    if (!state.nodes.fps) return
    const now = performance.now()
    const elapsed = now - state.fpsWindowStart
    if (elapsed <= 0) return
    const fps = Math.round((state.frames * 1000) / elapsed)
    state.frames = 0
    state.fpsWindowStart = now
    state.nodes.fps.textContent = `fps: ${fps}`
  }

  function startTicking() {
    stopTicking()
    state.timer = window.setInterval(updateClock, 1000)
    if (state.nodes.fps) {
      state.frames = 0
      state.fpsWindowStart = performance.now()
      state.rafId = window.requestAnimationFrame(measureFrame)
      state.fpsTimer = window.setInterval(updateFps, 1000)
    }
  }

  function stopTicking() {
    if (state.timer) window.clearInterval(state.timer)
    if (state.fpsTimer) window.clearInterval(state.fpsTimer)
    if (state.rafId) window.cancelAnimationFrame(state.rafId)
    state.timer = null
    state.fpsTimer = null
    state.rafId = null
  }

  function applyVisibility() {
    if (!state.root) return
    const visible = !state.config.onlyOnNewSession || isNewSessionSurface()
    state.root.hidden = !visible
    state.root.style.display = visible ? '' : 'none'
  }

  function watchSurface() {
    if (state.observer) return
    // New session <-> chat swaps in the SPA change both the tree and classes,
    // so watch both and debounce: applyVisibility runs a querySelector.
    let debounce = null
    const onChange = () => {
      if (debounce) return
      debounce = window.setTimeout(() => {
        debounce = null
        try { applyVisibility() } catch { /* ignore */ }
      }, 200)
    }
    window.addEventListener('hashchange', onChange)
    window.addEventListener('popstate', onChange)
    try {
      state.observer = new MutationObserver(onChange)
      state.observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class']
      })
    } catch {
      state.observer = null
    }
  }

  function remove() {
    stopTicking()
    stopContrast()
    const root = document.getElementById(ROOT_ID)
    if (root) root.remove()
    state.root = null
    state.nodes = {}
  }

  const api = {
    // Stable for the lifetime of the page, so `status` can prove that repeated
    // injections reuse one instance instead of stacking timers.
    instanceId: Math.random().toString(36).slice(2, 10),
    apply(next) {
      state.config = merge(state.config, next || {})
      if (!state.config.enabled) return api.disable()
      render()
      return api.state()
    },
    /** Re-apply a fresh injector payload without creating a second instance. */
    reset(nextBoot) {
      if (isObject(nextBoot)) boot = nextBoot
      stopTicking()
      state.config = merge(DEFAULTS, boot.config)
      if (!state.config.enabled) return api.disable()
      render()
      return api.state()
    },
    disable() {
      remove()
      return api.state()
    },
    /** Last wallpaper-luminance measurement and the palette it produced. */
    contrast() {
      return {
        palettes: state.palettes,
        pending: state.pending,
        sample: state.contrastSample,
        lastTrigger: state.lastTrigger,
        lastResampleAt: state.lastResampleAt,
        watched: state.wallpaperWatched
      }
    },
    /** Public interface: re-read the wallpaper and re-decide the palette now. */
    resample(reason) {
      if (!state.root) return api.contrast()
      scheduleResample(String(reason || 'api'), 0)
      return api.contrast()
    },
    state() {
      return {
        instanceId: api.instanceId,
        renders: state.renders,
        palettes: state.palettes,
        mounted: state.root !== null,
        visible: state.root !== null && !state.root.hidden,
        config: state.config
      }
    }
  }

  window.__dshDesktopWidgets = api
  try {
    api.apply(boot.config)
    watchSurface()
  } catch (error) {
    console.warn('[dsh-desktop-widgets] failed to render:', error)
  }
})()







