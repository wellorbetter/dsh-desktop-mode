/**
 * DSH desktop mode — settings page (client half of the plugin).
 *
 * This is a *classic script*, not a module: DSH loads plugin client bundles with
 * `document.createElement('script')` and hands the factory a synchronous
 * `require`, so top-level `import`/`export` would be a syntax error. React comes
 * from the shell's frozen module table (`require('react')`) — the same instance
 * the app renders with, so no duplicate React is ever loaded.
 *
 * The page is registered into the settings window's `settings.section` list, so
 * the widget configuration is edited where every other DSH setting lives. It
 * talks to the plugin's own host routes: nothing is written through the Cordis
 * configuration layer, which is what lets these settings survive plugin updates.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-desktop-mode',
  factory(require) {
    var React = require('react')
    var h = React.createElement

    var API = '/dsh-desktop-mode'
    // The host refuses mutating requests without this header (plugin routes are
    // not behind the instance token, so the endpoint checks its caller itself).
    var HEADERS = { 'Content-Type': 'application/json', 'X-DSH-Desktop-Mode': '1' }

    var STRINGS = {
      zh: {
        nav: '桌面挂件',
        intro: '这些设置即时写入宿主安装目录的配置文件，保存后挂件层立刻重画。',
        file: '配置文件',
        save: '保存',
        reload: '放弃改动，重新读取',
        saved: '已保存',
        loading: '正在读取…',
        loadFailed: '读取失败',
        saveFailed: '保存失败',
        applyFailed: '已保存，但挂件层没能重画：',
        refused: '以下值被拒绝，已保留原值：',
        groups: {
          general: '总开关',
          clock: '时间',
          contrast: '颜色与取色',
          caption: '手写文字',
          meta: '右上角信息',
          weather: '天气',
          character: '角色立绘'
        }
      }
    }

    function pick(locale) {
      var key = String(locale || '').toLowerCase()
      return STRINGS[key.indexOf('zh') === 0 ? 'zh' : 'zh'] || STRINGS.zh
    }

    function readPath(object, dotted) {
      var keys = dotted.split('.')
      var cursor = object
      for (var index = 0; index < keys.length; index += 1) {
        if (cursor === null || typeof cursor !== 'object') return undefined
        cursor = cursor[keys[index]]
      }
      return cursor
    }

    function writePath(object, dotted, value) {
      var keys = dotted.split('.')
      var cursor = object
      for (var index = 0; index < keys.length - 1; index += 1) {
        var key = keys[index]
        if (cursor[key] === null || typeof cursor[key] !== 'object') cursor[key] = {}
        cursor = cursor[key]
      }
      cursor[keys[keys.length - 1]] = value
      return object
    }

    function clone(value) {
      try { return JSON.parse(JSON.stringify(value)) } catch (error) { return {} }
    }

    // ---------------------------------------------------------------- styles --
    var STYLE = [
      '.dsh-dm-page{display:grid;gap:18px;padding:2px 2px 24px;font-size:13px}',
      '.dsh-dm-note{opacity:.68;line-height:1.5}',
      '.dsh-dm-path{font-family:ui-monospace,Consolas,monospace;font-size:12px;opacity:.72;word-break:break-all}',
      '.dsh-dm-group{display:grid;gap:10px;border:1px solid rgba(128,128,128,.22);border-radius:10px;padding:12px 14px}',
      '.dsh-dm-group>h3{margin:0;font-size:13px;font-weight:600}',
      '.dsh-dm-row{display:grid;grid-template-columns:minmax(140px,38%) 1fr;gap:10px;align-items:center}',
      '.dsh-dm-row>label{display:flex;align-items:center;gap:8px;cursor:pointer}',
      '.dsh-dm-hint{font-size:11px;opacity:.6;margin-top:2px}',
      '.dsh-dm-input,input.dsh-dm-input,select.dsh-dm-input{width:100%;box-sizing:border-box;padding:5px 8px;border-radius:7px;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;font:inherit}',
      '.dsh-dm-actions{display:flex;align-items:center;gap:10px;position:sticky;bottom:0;padding:10px 0;background:inherit}',
      '.dsh-dm-actions>button{padding:6px 14px;border-radius:8px;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;font:inherit;cursor:pointer}',
      '.dsh-dm-actions>button[data-primary="1"]{border-color:transparent;background:var(--dsw-accent, #4d6bfe);color:#fff}',
      '.dsh-dm-actions>button:disabled{opacity:.55;cursor:default}',
      '.dsh-dm-status{font-size:12px;opacity:.75}',
      '.dsh-dm-problem{color:#e0663d}'
    ].join('')

    function installStyle() {
      if (document.querySelector('style[data-plugin="dsh-plugin-desktop-mode"]') !== null) return
      var style = document.createElement('style')
      style.setAttribute('data-plugin', 'dsh-plugin-desktop-mode')
      style.textContent = STYLE
      document.head.appendChild(style)
    }

    // ------------------------------------------------------------------- api --
    function request(options) {
      return fetch(API + '/settings', options).then(function (response) {
        return response.json().then(function (payload) {
          return { status: response.status, payload: payload }
        })
      })
    }

    function load() {
      return request({ headers: HEADERS }).then(function (result) {
        if (!result.payload || result.payload.ok !== true) throw new Error('DSH_DESKTOP_MODE_SETTINGS_UNAVAILABLE')
        return result.payload
      })
    }

    function save(config) {
      return request({ method: 'POST', headers: HEADERS, body: JSON.stringify({ config: config }) })
        .then(function (result) {
          if (!result.payload || result.payload.ok !== true) {
            var detail = result.payload && (result.payload.error || result.payload.detail)
            throw new Error(detail || 'DSH_DESKTOP_MODE_SAVE_FAILED')
          }
          return result.payload
        })
    }

    /**
     * Ask the already-loaded widget layer to re-read the configuration it was
     * booted with. Without this a saved change would sit on disk until the user
     * happened to reload the page.
     */
    function applyToWidgets() {
      var api = window.__dshDesktopMode
      if (!api || typeof api.reloadWidgets !== 'function') return Promise.resolve(false)
      return Promise.resolve(api.reloadWidgets('settings-page')).then(function () { return true }, function () { return false })
    }

    // -------------------------------------------------------------- component --
    function Section(props) {
      var t = pick(props && props.locale)
      var snapshot = React.useState(null)
      var snap = snapshot[0]
      var setSnap = snapshot[1]
      var draftState = React.useState(null)
      var draft = draftState[0]
      var setDraft = draftState[1]
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var statusState = React.useState(null)
      var status = statusState[0]
      var setStatus = statusState[1]

      function refresh() {
        setStatus({ kind: 'info', text: t.loading })
        return load().then(function (payload) {
          setSnap(payload)
          setDraft(clone(payload.config))
          setStatus(null)
        }, function (error) {
          setStatus({ kind: 'problem', text: t.loadFailed + ': ' + String((error && error.message) || error) })
        })
      }

      React.useEffect(function () {
        installStyle()
        refresh()
      }, [])

      function setField(path, value) {
        setDraft(function (previous) {
          var next = clone(previous)
          writePath(next, path, value)
          return next
        })
      }

      function submit() {
        setBusy(true)
        setStatus({ kind: 'info', text: t.loading })
        save(draft).then(function (payload) {
          setSnap(function (previous) {
            var next = clone(previous)
            next.config = payload.config
            return next
          })
          setDraft(clone(payload.config))
          var problems = Array.isArray(payload.issues) ? payload.issues : []
          return applyToWidgets().then(function (applied) {
            var lines = [t.saved]
            if (problems.length > 0) {
              lines.push(t.refused + ' ' + problems.map(function (issue) { return issue.path + ' (' + issue.reason + ')' }).join('、'))
            }
            if (applied === false) lines.push(t.applyFailed + '（刷新页面即可）')
            setStatus({ kind: problems.length > 0 ? 'problem' : 'info', text: lines.join(' ') })
          })
        }, function (error) {
          setStatus({ kind: 'problem', text: t.saveFailed + ': ' + String((error && error.message) || error) })
        }).then(function () { setBusy(false) })
      }

      if (snap === null || draft === null) {
        return h('div', { className: 'dsh-dm-page' }, [
          h('p', { key: 'note', className: 'dsh-dm-note' }, status ? status.text : t.loading)
        ])
      }

      var groups = (snap.groups || []).map(function (group) {
        var fields = (snap.fields || []).filter(function (field) { return field.group === group.id })
        if (fields.length === 0) return null
        return h('section', { className: 'dsh-dm-group', key: group.id }, [
          h('h3', { key: 'title' }, t.groups[group.id] || group.label || group.id),
          h('div', { key: 'rows', style: { display: 'grid', gap: 10 } }, fields.map(renderField))
        ])
      }).filter(Boolean)

      function renderField(field) {
        var value = readPath(draft, field.path)
        var control
        if (field.type === 'boolean') {
          control = h('input', {
            type: 'checkbox',
            checked: value === true,
            disabled: busy,
            onChange: function (event) { setField(field.path, event.target.checked) }
          })
        } else if (field.type === 'enum') {
          control = h('select', {
            className: 'dsh-dm-input',
            value: String(value === undefined || value === null ? '' : value),
            disabled: busy,
            onChange: function (event) { setField(field.path, event.target.value) }
          }, (field.values || []).map(function (option) {
            return h('option', { key: option, value: option }, option)
          }))
        } else {
          control = h('input', {
            className: 'dsh-dm-input',
            type: field.type === 'number' ? 'number' : 'text',
            step: field.step === undefined ? undefined : String(field.step),
            min: field.min === undefined ? undefined : String(field.min),
            max: field.max === undefined ? undefined : String(field.max),
            value: value === undefined || value === null ? '' : String(value),
            disabled: busy,
            onChange: function (event) {
              setField(field.path, field.type === 'number' ? event.target.value : event.target.value)
            }
          })
        }
        return h('div', { className: 'dsh-dm-row', key: field.path }, [
          h('label', { key: 'label' }, [
            field.type === 'boolean' ? control : null,
            h('span', { key: 'text' }, [
              h('span', { key: 'name', style: { display: 'block' } }, field.label || field.path),
              field.hint ? h('span', { key: 'hint', className: 'dsh-dm-hint' }, field.hint) : null
            ])
          ]),
          field.type === 'boolean' ? h('span', { key: 'empty' }) : control
        ])
      }

      return h('div', { className: 'dsh-dm-page' }, [
        h('div', { key: 'intro' }, [
          h('p', { key: 'about', className: 'dsh-dm-note', style: { margin: '0 0 6px' } }, t.intro),
          h('p', { key: 'path', className: 'dsh-dm-path', style: { margin: 0 } },
            t.file + '：' + String(snap.configPath || ''))
        ]),
        h('div', { key: 'groups', style: { display: 'grid', gap: 14 } }, groups),
        h('div', { key: 'actions', className: 'dsh-dm-actions' }, [
          h('button', {
            key: 'save',
            type: 'button',
            'data-primary': '1',
            disabled: busy,
            onClick: submit
          }, t.save),
          h('button', {
            key: 'reload',
            type: 'button',
            disabled: busy,
            onClick: refresh
          }, t.reload),
          status !== null
            ? h('span', { key: 'status', className: 'dsh-dm-status' + (status.kind === 'problem' ? ' dsh-dm-problem' : '') }, status.text)
            : null
        ])
      ])
    }

    // ---------------------------------------------------------------- plugin --
    var inject = ['slots']
    function apply(ctx) {
      var slots = ctx.get ? ctx.get('slots') : ctx.slots
      if (slots === undefined || slots === null) return
      // `slots.inject` waits for the settings window to declare the slot; a bare
      // `register` would race it and silently do nothing.
      ctx.effect(function () {
        return slots.inject('settings.section', function () {
          return slots.register({
            name: 'settings.section',
            id: 'desktop-mode',
            order: 100,
            label: '桌面挂件'
          }, Section)
        })
      }, 'dsh-desktop-mode: settings section')
    }

    return { name: 'dsh-desktop-mode-settings', inject: inject, apply: apply }
  }
})
