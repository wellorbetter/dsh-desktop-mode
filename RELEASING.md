# 发布流程

这个仓库有两半：`plugin/`（装进 DSH 的插件）和 `host/` + `tools/`（原生宿主包）。对外只有一个渠道：**GitHub Release 里的自包含发行包 zip**（插件就装在包里）。

> 涉及 GitHub / npm 的动作（建仓库、push、打 tag、发 Release、publish）按 `personal-contribution` 的规矩走：确认仓库身份、分支、权限范围，不擅自扩大范围。

## 版本号

**唯一来源是 `plugin/package.json` 的 `version`。**

- 插件的 `/boot` 路由从包里的 `package.json` 读版本并下发给页面，页面显示的就是它（这条以前是硬编码的 `0.0.2`，会漂移，已改掉）；
- `packaging/build-release.ps1` 用同一个字段给 zip 命名；
- 宿主安装包（`host/`）跟着插件一起发，不单独编号。

发版时改这一个字段即可，然后：

```powershell
# 1. 契约测试
node test/widget-config.mjs

# 2. 组装发行包（会先编译原生工具；包内自带 exe，用户机器不需要编译器）
pwsh -File packaging/build-release.ps1
#    -> dist\dsh-desktop-mode-v<版本>.zip
#    -> dist\SHA256SUMS.txt

# 3. 验收这个产物本身（解包后逐项断言，见下）
pwsh -File packaging/verify-release.ps1
```

## `verify-release.ps1` 检查什么

它把 zip 解到临时目录，然后断言：

1. zip 的 sha256 与 `dist\SHA256SUMS.txt` 里记的一致（**stale 校验和是最容易发出去的错**）；
2. 安装器与启动器需要的每个文件都在（含原生 `tools/bin/dsh-desktop-input.exe`、托盘图标、插件四件套 `lib/{index,client,typing,settings-page}.js` 与 `lib/widgets/*`）；
3. 没有任何私有目录：`shell/` `logs/` `state/` `.evidence/` `config/` `dist/` `node_modules/`；
4. 没有任何私人绝对路径（某个用户的主目录、开发机的工程目录）、私人内容、密钥字面量；
5. 包里每个 `.js`/`.mjs` 都能 `node --check`，每个 `.ps1` 都能被 PowerShell 解析；
6. **解包出来的那份 `lib/widgets/config.js` 仍然满足配置契约**（拿恶意输入喂 `normalize()`，检查它被拒且被修好）；
7. 二进制只有原生工具和托盘图标两个；
8. `plugin/package.json` 声明了 `dsh.client.platform = web`，并且 `exports["./client"]` 指向的文件真的在包里。

退出码非 0 就不要发布。

## 发布前的手工验收（活体）

这些是脚本测不到的，必须在真实桌面上走一遍（用**桌面实例**那个 DSH，比如 `:3081`，别动自己正在用的实例）：

- [ ] `pwsh -File tools\dsh-desktop.ps1 status` → `layerOnDesktop True`、`layerParent SHELLDLL_DefView`、`widgetsMounted True`、`widgetsPid` 为空（说明没有旧注入 daemon）；
- [ ] 桌面图标已隐藏，层铺满全屏；
- [ ] 挂件层在（时钟/日期/手写文字…），壁纸换了会重新取色；
- [ ] **设置页**：侧栏「设置」→「桌面挂件」能打开，7 组 44 项，改一项保存后**挂件立刻重画**（不用刷页面）；
- [ ] 手改 `<安装目录>\widgets.json` 后再等一次轮询（约 3s）也会自动生效；
- [ ] **打字**：点桌面上的输入框能直接打字，`Esc`/点到别处回到桌面层，**且焦点还给原来那个窗口**（`demote` 的 `restoredTo` 不是空的）；
- [ ] 托盘：状态 / 重载挂件 / 显示隐藏图标 / 打字模式 / 回到桌面层 / 停止 都有效；
- [ ] `pwsh -File host\uninstall.ps1 -WhatIf` 的顺序正确（停层 → 撤自启 → 移插件 → 用户配置留 `.bak` → 删目录）。

## GitHub Release

1. 打 tag：`git tag v<版本>` 并 `git push origin main --tags`；
2. 建 Release，标题 `v<版本>`，正文用 `docs/release-notes/v<版本>.md`（里面已写好"有什么 / 安装 / 已知限制 / 校验方法"，发布时把 `sha256 = <发布时填入>` 换成 `dist\SHA256SUMS.txt` 里的值）；
3. **附件同时传 `dsh-desktop-mode-v<版本>.zip` 和 `SHA256SUMS.txt`** —— 校验和单独上传，用户才能核对下载物；
4. 正文里给出校验方法：
   `Get-FileHash .\dsh-desktop-mode-v<版本>.zip -Algorithm SHA256`。

> 发布前已核实（2026-10-08，只读）：npm 上 `dsh-plugin-desktop-mode` **未被占用**（registry 404），GitHub 上 `wellorbetter/dsh-desktop-mode` **未被占用**（API 404，且 `wellorbetter` 账号存在、id 与 git config 里的邮箱一致）。

## 渠道：只有 GitHub Release（npm 未启用）

**发行包是自包含的**：预编译好的原生工具 + 插件 + 安装器都在 zip 里，用户解压 → 双击 `host\install.cmd` 就完事，**不需要 npm、不需要联网、不需要编译器**。安装器默认就用包内那份插件（`link:<安装目录>\plugin`）。

因此**唯一渠道是 GitHub Release**：上传 `dsh-desktop-mode-v<版本>.zip` 与 `SHA256SUMS.txt`。

npm 渠道目前**不发布**（用户 2026-10-08 决定）。插件本身仍是一个合规的 npm 包，将来要发的话：

```powershell
cd plugin
pnpm pack --pack-destination <临时目录>   # 本机没有 npm CLI 时用它核对文件清单（正好 9 个文件）
pnpm publish --access public               # pnpm 11 自带 publish；需要 npm 登录凭据
```

发之前确认：

- 包里**没有** `widgets.json`（那是用户配置，装在安装目录里，不该进包）、没有 `logs/`、没有任何私人内容；
- `package.json` 的 `repository` / `homepage` / `bugs` / `author` 指向真实地址；
- 版本号与 GitHub Release 的 tag 一致；
- 一旦 npm 上有了包，安装器的 `-FromNpm` 才会真正有用（默认仍是包内那份）。

## 明确不发布的内容

- `shell/`：第三方桌面 App 的副本（约 318 MB，别人的作品）——`.gitignore` 与 `build-release.ps1` 的断言都拦它；
- `logs/`、`state/`、`.evidence/`、`config/`、`dist/`：运行状态、私有笔记、证据、本机配置、构建产物；
- `tools/bin/*.exe`：从 `tools/native/dsh-desktop-input.cs` 编译出来的，只随**发行包**走（zip 里必须有），但不进 git。

## English summary

The plugin's version lives in `plugin/package.json` only (the `/boot` route and
the page read it from there). To release: run `node test/widget-config.mjs`, then
`pwsh -File packaging/build-release.ps1`, then `pwsh -File packaging/verify-release.ps1`
— the last one extracts the archive and asserts the layout, the absence of private
content, that every shipped script parses, and that the shipped widget-config
contract still holds. Walk the live checklist above on a real desktop, tag
`v<version>`, attach **both** the zip and `SHA256SUMS.txt` to the GitHub Release,
There is no npm channel: the plugin ships inside the archive and the installer links the bundled copy, so installing needs no registry and no network.
