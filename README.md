# DSH 桌面模式（dsh-desktop-mode）

把 **DeepSeek Harness 变成 Windows 桌面**：DSH 网页铺满整个桌面，壁纸上方是你的时钟 / 日期 / 手写文字 / 天气 / fps 挂件，**点一下输入框就能直接打字**；别的前台窗口需要输入时它自动让位。

由两半组成（这不是二选一，是分工）：

- **DSH 插件**（`dsh-plugin-desktop-mode`）—— 界面里的一切：挂件层、打字触发、调用原生工具的 host 路由；
- **原生宿主**（本仓库 `host/` 与 `tools/`）—— 网页做不到的事：把窗口钉进 Explorer 桌面、隐藏图标、离开/回到桌面层并接管键盘、开机自启、托盘。

> 本仓库**不含**任何第三方桌面 App 的副本。安装器会找你已装的那个，或者把 `desktop.zip` 自动解包。

## 依赖

| | |
|---|---|
| 系统 | Windows 10 / 11 |
| DSH | 能跑 `dsh web`（web profile，内核 ≥ 0.1.5） |
| 宿主 App | 把 DSH 网页装进窗口的那个桌面端：官方桌面端 / DSH Desktop ≥ 2.0.7 / 壁纸插件的桌面版均可 |
| 可选 | `dsh-plugin-wallpaper-engine`（壁纸；不装就是纯色背景 + 挂件） |

## 安装

1. 从 Releases 下载 `dsh-desktop-mode-v<版本>.zip` 并解压；
2. 双击解压出来的 `host\install.cmd`（或 `pwsh -File host\install.ps1`）——**注意在 `host\` 子目录里**。它会：
   - 找到宿主 App（找不到会提示，或用 `-ShellExe "<exe 路径>"` 指定）；
   - 把工具装到 `%LOCALAPPDATA%\dsh-desktop-mode`；
   - 装插件（默认走 npm；离线或本地开发用 `-FromLocal`）；
   - 注册开机自启，然后立即启动。
3. 桌面随即变成 DSH。

常用参数：`-ShellExe` · `-FromLocal` · `-SkipAutostart` · `-SkipStart` · `-WhatIf`（只看计划不动手）。

## 卸载

`uninstall.cmd`：停层 → 恢复普通桌面 → 撤自启 → 移除插件 → 删安装目录。
你的挂件配置会保留成 `widgets.json.bak`；`-Purge` 才一并删除。

## 用法

- **打字**：点桌面上的输入框，直接输入；`Esc` 或点到别处即回到桌面层。
  **安全闸**：只有"当前前台本来就是桌面"时才会接管键盘 —— 它**不会**从游戏或别的程序手里抢键盘。
- **托盘**：状态 · 重载挂件 · 显示/隐藏桌面图标 · 打字模式 · 回到桌面层 · 停止。
- **配置**：在 DSH 的**设置窗口**里最下面一页「桌面挂件」改（总开关 / 时间 / 颜色与取色 / 手写文字 / 右上角信息 / 天气 / 角色立绘，44 项），**保存后挂件立刻重画（页面每 3s 轮询一次配置，最迟 3s 内生效），不用刷新页面**。设置也存在 `%LOCALAPPDATA%\dsh-desktop-mode\widgets.json`，手改这个文件同样生效（最多 3s 自动生效）。
- **命令**（安装目录里的 `tools\dsh-desktop.ps1`）：`start` / `stop` / `status` / `typing-on` / `typing-off` / `fill` / `icons-off` / `tray-reload`。

## 它是怎么工作的

- Windows 只把键盘送给**前台窗口**所在线程的输入队列；而贴在 Explorer 桌面里的窗口是子窗口，**永远不可能成为前台窗口**。所以在桌面上打字必须**临时离开桌面层**：窗口从"桌面子窗口"变回"普通顶层窗口"（外观、大小、位置完全不变，看不出来）→ 拿到键盘 → 点到别处再贴回去。
- 这一进一出会让 Windows 重建窗口的合成身份，中间有一两帧两边都不显示 ⇒ 用**冻屏遮罩**把最后一帧盖在切换过程上（约 160ms）遮掉。
- 文字颜色按**文字所在那一块**的壁纸亮度自动选白字/黑字，并带迟滞（视频壁纸逐帧明暗不会闪）。

## 隐私

完全在本机运行：插件的路由只服务本机页面（`127.0.0.1`），不上传任何东西，也不读取你的对话内容。原生工具只操作窗口（`SetParent` / 焦点 / 图标），系统层面唯一写入是开机自启那一项 `HKCU\...\Run`，卸载会删除。

## 已知限制

- 桌面图标默认隐藏（图标层会盖住桌面层）；用 `icons-on` 可显式显示。
- 托盘图标在 Windows 11 默认进"隐藏的图标"，可拖到任务栏固定。
- exe 未签名，SmartScreen 可能提示。
- 任务栏设为自动隐藏时：桌面层盖住整屏，鼠标移到底边会先退回桌面层、任务栏才弹出来（设计如此）。

## 开发

- **插件**：`plugin/` —— host `lib/index.js`、client `lib/client.js`、挂件 `lib/widgets/`、打字 `lib/typing.js`、设置页 `lib/settings-page.js`。
  本地安装：`dsh plugin --profile web add link:<本目录绝对路径>`。
- **原生工具**：`tools/native/dsh-desktop-input.cs`，用 `tools/build-input-helper.ps1` 编译（本机只有 .NET Framework 的 csc，所以源码是 C# 5 语法：没有元组、没有 `out var`、没有字符串插值）。
- **托盘图标**：`tools/make-icon.ps1` 现场生成 `tools/bin/dsh-desktop.ico`（自制，不含第三方素材）。
- **发行包**：`pwsh -File packaging/build-release.ps1` —— 会先编译原生工具，再复制 `host/` `tools/` `plugin/`，并**断言**包里没有 `shell/` `logs/` `state/` `.evidence/`。
- **发版流程**：见 [RELEASING.md](RELEASING.md)（版本号在哪、两个渠道怎么发、发前必跑 `packaging/verify-release.ps1` 与手工验收清单）。
- **测试**：`node test/widget-config.mjs` —— 挂件配置的校验契约（44 个字段的合法性、夹取、阈值对调等）。`node tools/clear-composer.mjs` 清空桌面实例输入框（DSH 的输入框是 React 管的，改 DOM 或发合成事件都会被它改回来，只有真按键才算）。

## 许可证

MIT
