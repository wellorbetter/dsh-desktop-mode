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

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC_BASE = '/dsh-desktop-mode'
const CLIENT_PATH = path.join(PACKAGE_ROOT, 'lib', 'client.js')
const TOOL_NAME = 'dsh-desktop-input.exe'

/** Where the host package installs the native tool. */
function installDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(base, 'dsh-desktop-mode')
}

function toolPath() {
  return process.env.DSH_DESKTOP_MODE_TOOL || path.join(installDir(), TOOL_NAME)
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
const DEFAULT_CONFIG = path.join(WIDGETS_DIR, 'default-config.json')
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

/** User config if present, else the shipped default; seeded on first boot. */
function widgetConfig() {
  const userPath = userConfigPath()
  const user = readJsonFile(userPath)
  if (user !== null) return user
  const shipped = readJsonFile(DEFAULT_CONFIG) ?? {}
  try {
    fs.mkdirSync(path.dirname(userPath), { recursive: true })
    fs.writeFileSync(userPath, JSON.stringify(shipped, null, 2), 'utf8')
  } catch { /* read-only install dir: fall back to the shipped default in memory */ }
  return shipped
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
            version: '0.0.2',
            config: widgetConfig(),
            css: readText(WIDGETS_CSS),
            configPath: userConfigPath()
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
          const chunks = []
          let size = 0
          req.on('data', (chunk) => {
            size += chunk.length
            if (size > 64 * 1024) { req.destroy(); return }
            chunks.push(chunk)
          })
          req.on('end', async () => {
            let payload = {}
            try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { payload = {} }
            const action = String(payload.action || '')
            if (!ACTIONS.has(action)) {
              sendJson(res, 400, { ok: false, error: 'DSH_DESKTOP_MODE_UNKNOWN_ACTION', action })
              return
            }
            const extra = []
            if (action === 'promote') {
              if (payload.force === true) extra.push('--force')
              if (payload.mask === false) extra.push('--no-mask')
            }
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
