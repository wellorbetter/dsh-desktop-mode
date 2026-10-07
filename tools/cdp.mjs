/**
 * Minimal Chrome DevTools Protocol client shared by the desktop-layer tools.
 *
 * The shell exposes no CLI hook for desktop mode or for injecting the widget
 * layer, so all three tools (desktop-mode, cdp-probe, inject-widgets) talk to
 * the page over `--remote-debugging-port`. Uses Node's built-in WebSocket and
 * fetch, so there is nothing to install.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Wait for a debuggable page target on the shell's debug port.
 * @param {{ port: number, timeoutMs?: number, match?: (target: any) => boolean }} options
 */
export async function findPageTarget({ port, timeoutMs = 30000, match } = {}) {
  if (!Number.isInteger(port) || port <= 0) throw new Error(`invalid debug port: ${port}`)
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  while (Date.now() < deadline) {
    try {
      // The per-request timeout matters: a listener that accepts connections but
      // never answers would otherwise hang this fetch for undici's ~300s default
      // and defeat the deadline below.
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })
      const targets = await response.json()
      const page = targets.find((t) => t.type === 'page' && (match ? match(t) : true))
      if (page?.webSocketDebuggerUrl) return page
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(1000)
  }
  throw new Error(`no debuggable page on port ${port} within ${timeoutMs}ms${lastError ? ` (${lastError})` : ''}`)
}

/**
 * Page target predicate used by every tool: the shell's window loads the DSH web
 * UI from localhost, so anything else (about:blank while booting, a DevTools
 * front-end) must not be picked.
 */
export function isDshPage(candidate) {
  return /^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(String(candidate?.url ?? ''))
}

/** One CDP connection with request/response correlation and event dispatch. */
export class CdpSession {
  static async open(target) {
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', () => reject(new Error('CDP socket error')), { once: true })
    })
    return new CdpSession(socket)
  }

  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    this.closed = false
    socket.addEventListener('close', () => this._onClose(new Error('CDP socket closed')))
    socket.addEventListener('error', () => this._onClose(new Error('CDP socket error')))
    socket.addEventListener('message', (event) => {
      let message
      try { message = JSON.parse(String(event.data)) } catch { return }
      if (message.id === undefined) {
        // Notification (event), not a response.
        for (const handler of this.listeners.get(message.method) ?? []) {
          try { handler(message.params ?? {}) } catch { /* listener errors are not fatal */ }
        }
        return
      }
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
    })
  }

  /** Subscribe to a CDP event, e.g. `Page.frameNavigated`. */
  on(method, handler) {
    const handlers = this.listeners.get(method) ?? []
    handlers.push(handler)
    this.listeners.set(method, handlers)
    return () => {
      const current = this.listeners.get(method) ?? []
      this.listeners.set(method, current.filter((entry) => entry !== handler))
    }
  }

  _onClose(error) {
    if (this.closed) return
    this.closed = true
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
    for (const handlers of this.listeners.values()) {
      for (const handler of handlers) {
        try { handler({ closed: true }) } catch { /* ignore */ }
      }
    }
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error('CDP session is closed'))
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) }
      })
      try {
        this.socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** Evaluate in the page and return the value; throws on page exceptions. */
  async evaluate(expression, { awaitPromise = true, timeoutMs = 30000 } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true
    }, timeoutMs)
    if (result?.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate threw'
      throw new Error(text)
    }
    return result?.result?.value
  }

  close() {
    this.closed = true
    try { this.socket.close() } catch { /* already closed */ }
  }
}

export { sleep }
