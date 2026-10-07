/**
 * DSH 桌面模式 —— 插件的 **host 半**（跑在 DSH 后台进程里）。
 *
 * 它做三件事，没有一件需要调试端口或往页面里注入：
 *
 *  1. 把 client 半交给页面。桌面壳的 index.html 由安装包静态直出，`tapIndex` 到不了它，
 *     唯一通道是往 `webserver/index-inject` 的结构化行里推一行**内联**脚本；浏览器形态
 *     则走 `tapIndex`。两条并存、按内容去重（照 dsh-whale-widget 的实测结论）。
 *  2. 提供 client 半要用的两条路由：`/dsh-desktop-mode/client.js` 与
 *     `/dsh-desktop-mode/<动作>`。
 *  3. 把动作翻译成对**原生工具**的调用，并把它的 JSON 原样回报 —— 状态一律以原生工具
 *     说的事实为准，宿主绝不缓存"我应该已经提升了"这种假设。
 *
 * 原生工具由配套的宿主安装包放在固定目录（默认 %LOCALAPPDATA%\dsh-desktop-mode\），
 * 也可用 DSH_DESKTOP_MODE_TOOL 指定。找不到工具时所有动作返回 ok:false + 明确错误码，
 * 页面据此保持原状而不是假装成功。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CONFIG, describe, normalize } from './widgets/config.js'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC_BASE = '/dsh-desktop-mode'
const CLIENT_PATH = path.join(PACKAGE_ROOT, 'lib', 'client.js')
const TOOL_NAME = 'dsh-desktop-input.exe'

/** Where the host package installs the native tool. */
function installDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(base, 'dsh-desktop-mode')
}

/** Version reported to the page: read from the package, so it cannot drift. */
function packageVersion() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Where the native tool is.
 *
 * The plugin and the host installer must agree on this: the installer copies the
 * packaged tree to `<install>\tools\...` (so the tool lands in `tools\bin\`) and
 * records that path as `tool` in `config.json`, while the plugin's own default
 * lives at the install root. Resolving the first candidate that exists means
 * either layout works, and a fresh install does not silently lose typing.
 */
function toolCandidates() {
  const candidates = []
  const override = process.env.DSH_DESKTOP_MODE_TOOL
  if (typeof override === 'string' && override !== '') candidates.push(override)
  const configured = hostConfig().tool
  if (typeof configured === 'string' && configured !== '') candidates.push(configured)
  candidates.push(path.join(installDir(), TOOL_NAME))
  candidates.push(path.join(installDir(), 'tools', 'bin', TOOL_NAME))
  return candidates
}

function toolPath() {
  const candidates = toolCandidates()
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch { /* unreadable candidate: try the next one */ }
  }
  return candidates[0]
}

/**
 * Host configuration written by the host package's installer.
 *
 * `shellExe` matters: the native tool identifies the window to pin by the
 * executable that owns it, and it can only guess that path when it sits next to
 * the shell's own tree. Installed under %LOCALAPPDATA% it cannot guess, so the
 * installer records the host app here (measured: without it the tool answers
 * DSH_INPUT_SHELL_WINDOW_NOT_FOUND).
 */
function hostConfig() {
  try {
    const text = fs.readFileSync(path.join(installDir(), 'config.json'), 'utf8')
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Actions the client half may ask for; anything else is refused. */
const ACTIONS = new Set(['status', 'promote', 'demote', 'detach', 'focus'])

/**
 * Header the shipped client sets on every mutating request.
 *
 * The web server does not authenticate plugin routes, so these endpoints are
 * reachable by any local process. Requiring a custom header makes a cross-origin
 * page unable to reach them without a preflight this server never approves (it
 * also makes the request non-simple, so browsers refuse to send it silently), and
 * the loopback Host check keeps a DNS-rebound name from being treated as local.
 */
const CLIENT_HEADER = 'x-dsh-desktop-mode'

function isLocalHost(host) {
  const name = String(host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  return name === '127.0.0.1' || name === 'localhost' || name === '::1'
}

/** Guard a mutating route: refuse callers that are not our own page. */
function refuseForeignRequest(req, res) {
  const header = req.headers[CLIENT_HEADER]
  if (header !== '1') {
    sendJson(res, 403, { ok: false, error: 'DSH_DESKTOP_MODE_FOREIGN_REQUEST' })
    return true
  }
  if (!isLocalHost(req.headers.host)) {
    sendJson(res, 403, { ok: false, error: 'DSH_DESKTOP_MODE_FOREIGN_HOST' })
    return true
  }
  return false
}

/**
 * Run the native tool and resolve its JSON ack.
 *
 * Errors are turned into a JSON ack rather than a rejection: every caller here is
 * a renderer waiting on a small JSON object, and "the tool is missing" is a
 * normal, reportable state (the plugin can be installed before the host package).
 */
function runNative(action, extraArgs = []) {
  const exe = toolPath()
  return new Promise((resolve) => {
    if (!fs.existsSync(exe)) {
      resolve({ ok: false, error: 'DSH_DESKTOP_MODE_TOOL_MISSING', tool: exe, hint: '安装配套的宿主包（或设置 DSH_DESKTOP_MODE_TOOL）' })
      return
    }
    const config = hostConfig()
    const shellArgs = []
    if (typeof config.shellExe === 'string' && config.shellExe !== '') shellArgs.push('--exe', config.shellExe)
    execFile(exe, [action, '--root', installDir(), ...shellArgs, ...extraArgs], {
      timeout: 15000,
      windowsHide: true,
      encoding: 'utf8'
    }, (error, stdout, stderr) => {
      const lines = String(stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      let parsed = null
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try { parsed = JSON.parse(lines[index]); break } catch { /* not the ack */ }
      }
      if (parsed === null) {
        resolve({
          ok: false,
          error: error ? `DSH_DESKTOP_MODE_TOOL_FAILED: ${error.message}` : 'DSH_DESKTOP_MODE_TOOL_OUTPUT_INVALID',
          detail: String(stderr ?? '').slice(0, 300)
        })
        return
      }
      resolve(parsed)
    })
  })
}

function readClient() {
  try { return fs.readFileSync(CLIENT_PATH, 'utf8') } catch { return '' }
}

const WIDGETS_DIR = path.join(PACKAGE_ROOT, 'lib', 'widgets')
const WIDGETS_JS = path.join(WIDGETS_DIR, 'widgets.js')
const WIDGETS_CSS = path.join(WIDGETS_DIR, 'widgets.css')
const DEFAULT_CONFIG_PATH = path.join(WIDGETS_DIR, 'default-config.json')
const TYPING_JS = path.join(PACKAGE_ROOT, 'lib', 'typing.js')

/**
 * Where the widget configuration lives once installed.
 *
 * Deliberately a plain file under the install dir rather than something baked
 * into the package: it is what the settings page writes (next step) and what a
 * user can edit by hand today, and it survives plugin updates.
 */
function userConfigPath() {
  return path.join(installDir(), 'widgets.json')
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/** The configuration the page is served: shipped default ⊕ the user's file, normalized. */
function widgetConfig() {
  const shipped = readJsonFile(DEFAULT_CONFIG_PATH) ?? DEFAULT_CONFIG
  const userPath = userConfigPath()
  const user = readJsonFile(userPath)
  if (user === null) {
    // First boot: seed the file so it is there to edit (by hand today, by the
    // settings page in the same round).
    const seeded = normalize(shipped, shipped).config
    try {
      fs.mkdirSync(path.dirname(userPath), { recursive: true })
      fs.writeFileSync(userPath, `${JSON.stringify(seeded, null, 2)}\n`, 'utf8')
    } catch { /* read-only install dir: keep serving the in-memory value */ }
    return seeded
  }
  return normalize(user, shipped).config
}

/**
 * Persist a settings patch.
 *
 * Writes through a temporary file and renames, so a crash mid-write cannot leave
 * the layer with a half-written configuration; the caller gets back the value
 * that is actually stored, which is what the page then renders.
 */
function saveWidgetConfig(patch) {
  const shipped = readJsonFile(DEFAULT_CONFIG_PATH) ?? DEFAULT_CONFIG
  const current = widgetConfig()
  const merged = normalize(patch, current)
  const target = userConfigPath()
  const temp = `${target}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(temp, `${JSON.stringify(merged.config, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, target)
  return merged
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return '' }
}

function sendText(res, contentType, body) {
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(body))
  })
  res.end(body)
}

/**
 * Inline row: build the <script> ourselves and swallow its error, so a missing
 * route can never reject the page's boot (the desktop shell rejects its whole
 * __DSH_BOOT_READY__ when a `script-src` row fails to load).
 */
const LOADER_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
  `var s=document.createElement("script");s.src="${PUBLIC_BASE}/client.js";` +
  's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

function hasRow(table, needle) {
  return table.some((row) => row && (
    (row.kind === 'script' && typeof row.text === 'string' && row.text.includes(needle)) ||
    (row.kind === 'script-src' && String(row.src || '').includes(needle))
  ))
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(text))
  })
  res.end(text)
}

/**
 * Read a small JSON request body.
 *
 * The cap is deliberate: these routes accept a settings form or an action, never
 * a payload, so an oversized body is refused instead of buffered.
 */
function readJsonBody(req, res, limit, onBody) {
  const chunks = []
  let size = 0
  let refused = false
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > limit) {
      refused = true
      // Answer before tearing the socket down: a client that only sees a reset
      // cannot tell "too large" from "the layer is broken".
      sendJson(res, 413, { ok: false, error: 'DSH_DESKTOP_MODE_BODY_TOO_LARGE', limit })
      req.destroy()
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => {
    if (refused) return
    let payload = null
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { payload = null }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      sendJson(res, 400, { ok: false, error: 'DSH_DESKTOP_MODE_BAD_JSON' })
      return
    }
    onBody(payload)
  })
  req.on('error', () => sendJson(res, 400, { ok: false, error: 'DSH_DESKTOP_MODE_BAD_REQUEST' }))
}

export default {
  name: 'dsh-desktop-mode',
  apply(root) {
    const disposers = []
    root.effect(() => () => {
      for (const dispose of disposers) { try { dispose() } catch { /* already gone */ } }
    })

    // ① Desktop shell: the structured injection table, collected once at host boot.
    disposers.push(root.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return
        if (hasRow(table, `${PUBLIC_BASE}/client.js`)) return
        table.push({ kind: 'script', placement: 'body', text: LOADER_ROW_TEXT })
      } catch { /* never break the host over an injection row */ }
    }))

    // ② Everything that needs the web server.
    root.inject(['webServer'], (ctx) => {
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: `${PUBLIC_BASE}/client.js`,
        handler: (req, res) => {
          const body = readClient()
          if (body === '') {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('client.js missing from the package')
            return
          }
          res.writeHead(200, {
            'Content-Type': 'text/javascript; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Length': String(Buffer.byteLength(body))
          })
          res.end(body)
        }
      }))

      // The widget half: the page asks for the boot payload (config + css),
      // then loads the widget code from here. Nothing is injected by an external
      // daemon any more — the plugin serves its own assets like any web app.
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: `${PUBLIC_BASE}/boot`,
        handler: (req, res) => {
          sendJson(res, 200, {
            ok: true,
            version: packageVersion(),
            config: widgetConfig(),
            css: readText(WIDGETS_CSS),
            configPath: userConfigPath()
          })
        }
      }))

      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: `${PUBLIC_BASE}/settings`,
        handler: (req, res) => {
          const method = (req.method || 'GET').toUpperCase()
          if (method === 'GET') {
            const config = widgetConfig()
            sendJson(res, 200, {
              ok: true,
              config,
              configPath: userConfigPath(),
              ...describe(config)
            })
            return
          }
          if (method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          if (refuseForeignRequest(req, res)) return
          readJsonBody(req, res, 64 * 1024, (payload) => {
            try {
              // `patch` merges into the stored configuration; `config` replaces it.
              const merged = saveWidgetConfig(payload.config ?? payload.patch ?? {})
              sendJson(res, 200, { ok: true, config: merged.config, issues: merged.issues })
            } catch (error) {
              sendJson(res, 500, { ok: false, error: 'DSH_DESKTOP_MODE_SAVE_FAILED', detail: String(error && error.message).slice(0, 200) })
            }
          })
        }
      }))

      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: `${PUBLIC_BASE}/widgets.js`,
        handler: (req, res) => {
          const body = readText(WIDGETS_JS)
          if (body === '') { res.writeHead(404); res.end('widgets.js missing'); return }
          sendText(res, 'text/javascript; charset=utf-8', body)
        }
      }))

      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: `${PUBLIC_BASE}/widgets.css`,
        handler: (req, res) => sendText(res, 'text/css; charset=utf-8', readText(WIDGETS_CSS))
      }))

      // The typing trigger. It used to arrive through the same document-start
      // payload as the widgets; serving it like any other asset is what removes
      // the debug port and the resident daemon from the picture.
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: `${PUBLIC_BASE}/typing.js`,
        handler: (req, res) => {
          const body = readText(TYPING_JS)
          if (body === '') { res.writeHead(404); res.end('typing.js missing'); return }
          sendText(res, 'text/javascript; charset=utf-8', body)
        }
      }))

      // The wallpaper plugin persists the current wallpaper id in its own config,
      // port-independently. The old injection daemon watched that file on the host
      // side; the plugin keeps the same capability by letting the page poll this
      // one cheap number (an in-page observer sees nothing when a scene wallpaper
      // swaps frames inside the same element).
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: `${PUBLIC_BASE}/wallpaper-id`,
        handler: (req, res) => {
          let id = ''
          try {
            const raw = fs.readFileSync(path.join(os.homedir(), '.dsh-wallpaper-engine', 'config.json'), 'utf8')
            id = String(JSON.parse(raw)?.settings?.id ?? '')
          } catch { id = '' }
          sendJson(res, 200, { ok: true, id })
        }
      }))

      // One route for every action: the client posts {action, ...} and gets the
      // native tool's own JSON back. Kept deliberately thin — the plugin must not
      // invent state the native side did not report.
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: `${PUBLIC_BASE}/action`,
        handler: (req, res) => {
          if ((req.method || 'GET').toUpperCase() !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          if (refuseForeignRequest(req, res)) return
          readJsonBody(req, res, 64 * 1024, async (payload) => {
            const action = String(payload.action || '')
            if (!ACTIONS.has(action)) {
              sendJson(res, 400, { ok: false, error: 'DSH_DESKTOP_MODE_UNKNOWN_ACTION', action })
              return
            }
            // `--no-mask` is a cosmetic A/B switch the shipped client already uses;
            // `--force` (bypass the foreground safety rail) is deliberately NOT
            // reachable from here: the page never needs it, and an endpoint that
            // any local process can reach must not be able to pull the layer out
            // from under another application.
            const extra = []
            if (action === 'promote' && payload.mask === false) extra.push('--no-mask')
            sendJson(res, 200, await runNative(action, extra))
          })
          req.on('error', () => sendJson(res, 400, { ok: false, error: 'DSH_DESKTOP_MODE_BAD_REQUEST' }))
        }
      }))

      // ③ Browser form: transform the served index.html. The desktop shell ignores
      // this (its html is static), which is why ① exists as well.
      if (typeof ctx.webServer.tapIndex === 'function') {
        disposers.push(ctx.webServer.tapIndex((html) => {
          try {
            if (typeof html !== 'string' || html.includes(`${PUBLIC_BASE}/client.js`)) return html
            const tag = `<script src="${PUBLIC_BASE}/client.js"></script>`
            return html.includes('</body>') ? html.replace('</body>', `${tag}</body>`) : html + tag
          } catch { return html }
        }))
      }
    })
  }
}
