/**
 * Widget-configuration contract checks.
 *
 * `normalize()` is the single gate between an untrusted `widgets.json` (or a
 * settings form) and the widget layer, so it is checked directly rather than
 * only through a running DSH instance. Run:
 *
 *   node test/widget-config.mjs
 */
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, describe, normalize } from '../plugin/lib/widgets/config.js'

let checks = 0
const check = (name, fn) => {
  try {
    fn()
    checks += 1
  } catch (error) {
    console.error(`FAIL  ${name}`)
    console.error(`      ${error.message}`)
    process.exitCode = 1
  }
}

check('empty input yields a complete configuration', () => {
  const { config, issues } = normalize({}, DEFAULT_CONFIG)
  assert.deepEqual(issues, [])
  assert.equal(config.enabled, true)
  assert.equal(config.clock.scale, 1)
  assert.equal(config.clock.anchor.left, '14.6%')
  assert.equal(config.character.height, '30%')
  assert.equal(config.weather.enabled, false)
})

check('nothing at all still yields every editable field', () => {
  const { config } = normalize(undefined)
  assert.equal(typeof config.clock, 'object')
  assert.equal(config.clock.shadow, 'strong')
  assert.equal(config.contrast.mode, 'auto')
  assert.equal(config.caption.text, '')
})

check('garbage input is refused, not stored, and does not throw', () => {
  const { config, issues } = normalize({
    enabled: 'maybe',
    clock: { scale: 'huge', shadow: 'sparkly', stroke: { deep: true }, color: 'red; background: url(x)' },
    contrast: { mode: 'sepia' },
    caption: { text: 42 },
    character: { src: 'javascript:alert(1)' }
  }, DEFAULT_CONFIG)
  const refused = new Set(issues.map((issue) => issue.path))
  assert.ok(refused.has('enabled'))
  assert.ok(refused.has('clock.scale'))
  assert.ok(refused.has('clock.shadow'))
  assert.ok(refused.has('clock.stroke'))
  assert.ok(refused.has('clock.color'))
  assert.ok(refused.has('contrast.mode'))
  assert.ok(refused.has('character.src'))
  // Refused values keep the value beneath them.
  assert.equal(config.enabled, true)
  assert.equal(config.clock.scale, 1)
  assert.equal(config.clock.shadow, 'strong')
  assert.equal(config.clock.color, '')
  assert.equal(config.character.src, '')
  // A number where a string belongs is coerced, not refused.
  assert.equal(config.caption.text, '42')
})

check('numbers are clamped into range and snapped to their step', () => {
  const { config } = normalize({
    clock: { scale: 99, weight: 37, stroke: -4, backdrop: 5 },
    contrast: { intervalMs: 10, sampleWidth: 99999, switchAfter: 0 }
  }, DEFAULT_CONFIG)
  assert.equal(config.clock.scale, 4)
  assert.equal(config.clock.weight, 100)
  assert.equal(config.clock.stroke, 0)
  assert.equal(config.clock.backdrop, 0.6)
  assert.equal(config.contrast.intervalMs, 1000)
  assert.equal(config.contrast.sampleWidth, 1024)
  assert.equal(config.contrast.switchAfter, 1)
})

check('anchors accept bare numbers and lose nothing', () => {
  const { config, issues } = normalize({ clock: { anchor: { left: '12', top: 30.5 } } }, DEFAULT_CONFIG)
  assert.deepEqual(issues, [])
  assert.equal(config.clock.anchor.left, '12%')
  assert.equal(config.clock.anchor.top, '30.5%')
})

check('inverted contrast thresholds are swapped, and reported', () => {
  const { config, issues } = normalize({ contrast: { darkBelow: 0.9, lightAbove: 0.2 } }, DEFAULT_CONFIG)
  assert.equal(config.contrast.darkBelow, 0.2)
  assert.equal(config.contrast.lightAbove, 0.9)
  assert.equal(issues.length, 1)
})

check('booleans accept strings, since forms send text', () => {
  const { config } = normalize({ enabled: 'false', clock: { hour12: 'true', showSeconds: 'off' } }, DEFAULT_CONFIG)
  assert.equal(config.enabled, false)
  assert.equal(config.clock.hour12, true)
  assert.equal(config.clock.showSeconds, false)
})

check('the shipped default file and the inlined defaults agree', async () => {
  const fs = await import('node:fs')
  const url = new URL('../plugin/lib/widgets/default-config.json', import.meta.url)
  const shipped = JSON.parse(fs.readFileSync(url, 'utf8'))
  const fromFile = normalize(shipped, DEFAULT_CONFIG).config
  const fromInline = normalize(DEFAULT_CONFIG, DEFAULT_CONFIG).config
  assert.deepEqual(fromFile, fromInline)
})

check('a patch only changes what it names', () => {
  const base = normalize({ caption: { text: 'kept' } }, DEFAULT_CONFIG).config
  const { config } = normalize({ clock: { showSeconds: true } }, base)
  assert.equal(config.caption.text, 'kept')
  assert.equal(config.clock.showSeconds, true)
})

check('describe() exposes every field with its current value', () => {
  const config = normalize({ clock: { scale: 2 } }, DEFAULT_CONFIG).config
  const table = describe(config)
  assert.equal(table.fields.length, 44)
  const scale = table.fields.find((field) => field.path === 'clock.scale')
  assert.equal(scale.value, 2)
  assert.ok(table.groups.some((group) => group.id === 'weather'))
})

check('a cleared number box keeps the value beneath it', () => {
  const base = normalize({ clock: { scale: 2 } }, DEFAULT_CONFIG).config
  const { config, issues } = normalize({ clock: { scale: '', stroke: '   ' } }, base)
  assert.equal(config.clock.scale, 2)
  assert.equal(config.clock.stroke, base.clock.stroke)
  assert.equal(issues.length, 2)
  assert.match(issues[0].reason, /empty number/)
})

check('long strings are truncated rather than stored whole', () => {
  const { config } = normalize({ caption: { text: 'x'.repeat(5000) } }, DEFAULT_CONFIG)
  assert.equal(config.caption.text.length, 200)
})

check('documentation keys are never persisted', () => {
  const { config } = normalize({ clock: { enabled_comment: 'hi' } }, { ...DEFAULT_CONFIG, clock: { ...DEFAULT_CONFIG.clock, enabled_comment: 'hi' } })
  assert.equal(config.clock.enabled_comment, undefined)
  assert.equal(JSON.stringify(config).includes('_comment'), false)
})

if (process.exitCode === 1) {
  console.error(`\n${checks} check(s) passed before the failures above`)
} else {
  console.log(`ok - ${checks} widget-config checks passed`)
}
