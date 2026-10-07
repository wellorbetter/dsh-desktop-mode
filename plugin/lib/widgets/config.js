/**
 * Widget configuration: one table that drives both validation and the settings UI.
 *
 * Two callers need the same knowledge of these fields — the host half when it
 * serves/accepts configuration, and the settings page when it renders a form.
 * Keeping a single declarative table here means a field cannot be editable in
 * the UI but rejected on save (or vice versa).
 *
 * Everything is deliberately total: `normalize()` never throws, always returns
 * a complete, well-formed configuration, and reports what it had to change. A
 * hostile or stale `widgets.json` must never be able to break the layer, and a
 * settings page must never be able to store a value the widget code cannot
 * render.
 */

/** Editable fields, in the order the settings page lays them out. */
export const FIELDS = [
  { path: 'enabled', group: 'general', type: 'boolean', label: '启用挂件层' },
  { path: 'onlyOnNewSession', group: 'general', type: 'boolean', label: '只在新会话显示' },

  { path: 'clock.enabled', group: 'clock', type: 'boolean', label: '显示时间' },
  { path: 'clock.temperature', group: 'clock', type: 'string', maxLength: 12, label: '时间上方小字', hint: '例如 28°，留空不显示' },
  { path: 'clock.hour12', group: 'clock', type: 'boolean', label: '12 小时制' },
  { path: 'clock.showSeconds', group: 'clock', type: 'boolean', label: '显示秒' },
  { path: 'clock.showDate', group: 'clock', type: 'boolean', label: '显示日期' },
  { path: 'clock.showWeekday', group: 'clock', type: 'boolean', label: '显示星期' },
  { path: 'clock.weekdayLocale', group: 'clock', type: 'string', maxLength: 16, pattern: '^[A-Za-z-]{2,16}$', label: '星期语言', hint: 'en / zh-CN / ja …' },
  { path: 'clock.scale', group: 'clock', type: 'number', min: 0.4, max: 4, step: 0.05, label: '时间字号' },
  { path: 'clock.color', group: 'clock', type: 'color', label: '时间颜色', hint: '留空 = 跟随壁纸明暗自动选' },
  { path: 'clock.weight', group: 'clock', type: 'number', min: 100, max: 900, step: 50, label: '字重' },
  { path: 'clock.stroke', group: 'clock', type: 'number', min: 0, max: 6, step: 0.5, label: '描边' },
  { path: 'clock.shadow', group: 'clock', type: 'enum', values: ['strong', 'soft', 'none'], label: '投影' },
  { path: 'clock.backdrop', group: 'clock', type: 'number', min: 0, max: 0.6, step: 0.02, label: '文字柔光' },
  { path: 'clock.anchor.left', group: 'clock', type: 'percent', label: '横向位置' },
  { path: 'clock.anchor.top', group: 'clock', type: 'percent', label: '纵向位置' },

  { path: 'contrast.enabled', group: 'contrast', type: 'boolean', label: '按壁纸取色' },
  { path: 'contrast.mode', group: 'contrast', type: 'enum', values: ['auto', 'light', 'dark'], label: '颜色模式' },
  { path: 'contrast.watchWallpaper', group: 'contrast', type: 'boolean', label: '换壁纸就重新取色' },
  { path: 'contrast.intervalMs', group: 'contrast', type: 'number', min: 1000, max: 3600000, step: 1000, label: '兜底重采样间隔（毫秒）' },
  { path: 'contrast.darkBelow', group: 'contrast', type: 'number', min: 0, max: 1, step: 0.01, label: '深色判定阈值' },
  { path: 'contrast.lightAbove', group: 'contrast', type: 'number', min: 0, max: 1, step: 0.01, label: '亮色判定阈值' },
  { path: 'contrast.switchAfter', group: 'contrast', type: 'number', min: 1, max: 30, step: 1, label: '切换前需连续一致次数' },
  { path: 'contrast.sampleWidth', group: 'contrast', type: 'number', min: 32, max: 1024, step: 8, label: '取色采样宽度' },

  { path: 'caption.enabled', group: 'caption', type: 'boolean', label: '显示手写文字' },
  { path: 'caption.text', group: 'caption', type: 'string', maxLength: 200, label: '文字', multiline: true },
  { path: 'caption.sub', group: 'caption', type: 'string', maxLength: 200, label: '小字', multiline: true },

  { path: 'meta.enabled', group: 'meta', type: 'boolean', label: '显示右上角信息' },
  { path: 'meta.showFps', group: 'meta', type: 'boolean', label: '显示 fps' },
  { path: 'meta.themeName', group: 'meta', type: 'string', maxLength: 80, label: '壁纸主题名' },
  { path: 'meta.themeAlias', group: 'meta', type: 'string', maxLength: 80, label: '主题别名' },
  { path: 'meta.anchor.right', group: 'meta', type: 'percent', label: '横向位置' },
  { path: 'meta.anchor.top', group: 'meta', type: 'percent', label: '纵向位置' },

  { path: 'weather.enabled', group: 'weather', type: 'boolean', label: '显示天气' },
  { path: 'weather.glyph', group: 'weather', type: 'string', maxLength: 8, label: '天气符号', hint: '一个字或 emoji，例如 雪 / ☀' },
  { path: 'weather.temperature', group: 'weather', type: 'string', maxLength: 12, label: '温度', hint: '例如 26°' },
  { path: 'weather.anchor.right', group: 'weather', type: 'percent', label: '横向位置' },
  { path: 'weather.anchor.top', group: 'weather', type: 'percent', label: '纵向位置' },

  { path: 'character.enabled', group: 'character', type: 'boolean', label: '显示角色立绘' },
  { path: 'character.src', group: 'character', type: 'string', maxLength: 4096, label: '图片地址', hint: 'http(s) 地址或 data:image/...' },
  { path: 'character.height', group: 'character', type: 'percent', label: '高度（占屏高比例）' },
  { path: 'character.anchor.right', group: 'character', type: 'percent', label: '横向位置' },
  { path: 'character.anchor.bottom', group: 'character', type: 'percent', label: '距底部' }
]

/** Groups as the settings page shows them. */
export const GROUPS = [
  { id: 'general', label: '总开关' },
  { id: 'clock', label: '时间' },
  { id: 'contrast', label: '颜色与取色' },
  { id: 'caption', label: '手写文字' },
  { id: 'meta', label: '右上角信息' },
  { id: 'weather', label: '天气' },
  { id: 'character', label: '角色立绘' }
]

/** Percent anchors accept `12%`, `12`, `12.5%`; anything else keeps the previous value. */
const PERCENT = /^(-?\d+(?:\.\d+)?)%?$/
/** Hex, rgb()/rgba(), hsl()/hsla(), or a plain CSS colour name. */
const COLOR = /^(#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\([0-9.,%\s]+\)|hsla?\([0-9.,%\s]+\)|[a-z]{3,20})$/i
const IMAGE_SRC = /^(https?:\/\/|data:image\/)/i

function readPath(object, dotted) {
  let cursor = object
  for (const key of dotted.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = cursor[key]
  }
  return cursor
}

function writePath(object, dotted, value) {
  const keys = dotted.split('.')
  let cursor = object
  for (const key of keys.slice(0, -1)) {
    if (cursor[key] === null || typeof cursor[key] !== 'object') cursor[key] = {}
    cursor = cursor[key]
  }
  cursor[keys[keys.length - 1]] = value
  return object
}

/** Clamp a number into the field's range; returns null when it is not a number. */
function coerceNumber(value, field) {
  const number = typeof value === 'number' ? value : Number(String(value ?? '').trim())
  if (!Number.isFinite(number)) return null
  const min = field.min ?? -Infinity
  const max = field.max ?? Infinity
  const clamped = Math.min(max, Math.max(min, number))
  const step = field.step
  if (typeof step === 'number' && step > 0) {
    const snapped = Math.round(clamped / step) * step
    // Snap can push a value one step out of range; clamp again and shed float dust.
    return Number(Math.min(max, Math.max(min, snapped)).toFixed(6))
  }
  return Number(clamped.toFixed(6))
}

function coerceBoolean(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(text)) return true
    if (['false', '0', 'no', 'off', ''].includes(text)) return false
  }
  return null
}

function coerceString(value, field) {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'string' ? value : String(value)
  const max = field.maxLength ?? 200
  return text.length > max ? text.slice(0, max) : text
}

/**
 * Coerce one value against its field.
 *
 * @returns `{ value }` on success or `{ reason }` describing why it was refused.
 */
export function coerceField(field, value) {
  switch (field.type) {
    case 'boolean': {
      const bool = coerceBoolean(value)
      return bool === null ? { reason: 'not a boolean' } : { value: bool }
    }
    case 'number': {
      const number = coerceNumber(value, field)
      return number === null ? { reason: 'not a number' } : { value: number }
    }
    case 'enum': {
      const text = String(value ?? '')
      return field.values.includes(text) ? { value: text } : { reason: `not one of ${field.values.join('|')}` }
    }
    case 'percent': {
      const match = PERCENT.exec(String(value ?? '').trim())
      if (match === null) return { reason: 'not a percentage' }
      const number = Number(match[1])
      if (!Number.isFinite(number)) return { reason: 'not a percentage' }
      return { value: `${Number(Math.min(100, Math.max(0, number)).toFixed(3))}%` }
    }
    case 'color': {
      const text = coerceString(value, { maxLength: 64 }).trim()
      if (text === '') return { value: '' }
      return COLOR.test(text) ? { value: text } : { reason: 'not a CSS colour' }
    }
    case 'string':
    default: {
      let text = coerceString(value, field)
      if (field.pattern !== undefined && text !== '' && !new RegExp(field.pattern).test(text)) {
        return { reason: 'does not match ' + field.pattern }
      }
      if (field.path === 'character.src' && text !== '' && !IMAGE_SRC.test(text)) {
        return { reason: 'not an http(s) or data:image URL' }
      }
      return { value: text }
    }
  }
}

/** Strip `*_comment` documentation keys; they are read from the shipped default only. */
function withoutComments(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(withoutComments)
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key === '_comment' || key.endsWith('_comment')) continue
    out[key] = withoutComments(entry)
  }
  return out
}

/**
 * Normalize a widget configuration.
 *
 * `input` fields win over `base` fields; every field the UI can edit is present
 * in the result (so the page never has to guess a default), and unmodelled
 * top-level keys from `base` are preserved rather than dropped.
 *
 * @param input - untrusted configuration (a settings patch or an edited file).
 * @param base - the configuration to fall back to, normally defaults ⊕ current file.
 * @returns `{ config, issues }` — `issues` lists every refused or adjusted field.
 */
export function normalize(input, base = {}) {
  const issues = []
  const source = input !== null && typeof input === 'object' ? input : {}
  const fallback = base !== null && typeof base === 'object' ? base : {}
  const config = withoutComments(fallback)

  for (const field of FIELDS) {
    const raw = readPath(source, field.path)
    if (raw === undefined) continue
    const result = coerceField(field, raw)
    if (result.value === undefined) {
      issues.push({ path: field.path, reason: result.reason, refused: raw })
      continue
    }
    writePath(config, field.path, result.value)
  }

  // Fields absent from both input and base still need a value the page can read.
  const defaults = DEFAULT_CONFIG
  for (const field of FIELDS) {
    if (readPath(config, field.path) === undefined) {
      writePath(config, field.path, readPath(defaults, field.path))
    }
  }

  // darkBelow must stay below lightAbove, or the hysteresis window is empty and
  // the colour choice flickers. A user who inverts them gets them swapped.
  const contrast = config.contrast
  if (contrast !== null && typeof contrast === 'object') {
    const dark = Number(contrast.darkBelow)
    const light = Number(contrast.lightAbove)
    if (Number.isFinite(dark) && Number.isFinite(light) && dark > light) {
      contrast.darkBelow = light
      contrast.lightAbove = dark
      issues.push({ path: 'contrast.darkBelow', reason: 'swapped with lightAbove (darkBelow must stay below it)' })
    }
  }

  return { config, issues }
}

/** Effective value of one editable field, for the settings page's initial state. */
export function fieldValue(config, dotted) {
  const value = readPath(config, dotted)
  return value === undefined ? null : value
}

/** The field table plus current values, as the settings page consumes it. */
export function describe(config) {
  return {
    groups: GROUPS,
    fields: FIELDS.map((field) => ({ ...field, value: fieldValue(config, field.path) }))
  }
}

/**
 * Shipped defaults, inlined so this module has no file-system dependency.
 *
 * Keeping them here (rather than reading `default-config.json`) means the
 * settings page can run in the browser and still know every default; the JSON
 * file stays the human-readable/documentable copy, and `boot` prefers it.
 */
export const DEFAULT_CONFIG = {
  enabled: true,
  onlyOnNewSession: false,
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
    color: '',
    weight: 300,
    stroke: 1,
    shadow: 'strong',
    backdrop: 0.28
  },
  contrast: {
    enabled: true,
    mode: 'auto',
    watchWallpaper: true,
    intervalMs: 30000,
    darkBelow: 0.45,
    lightAbove: 0.55,
    switchAfter: 3,
    sampleWidth: 160
  },
  caption: { enabled: true, text: '', sub: '' },
  meta: { enabled: true, anchor: { right: '3.2%', top: '10.2%' }, showFps: true, themeName: '', themeAlias: '' },
  weather: { enabled: false, anchor: { right: '2.3%', top: '0.9%' }, glyph: '', temperature: '' },
  character: { enabled: false, src: '', anchor: { right: '1.6%', bottom: '0.8%' }, height: '30%' }
}
