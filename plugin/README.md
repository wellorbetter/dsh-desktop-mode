# dsh-plugin-desktop-mode

把 DSH 变成 Windows 桌面：壁纸上方的时间 / 日期 / 手写文字 / 天气 / fps 挂件层，以及"点输入框就能打字"（原生工具负责离开、回到桌面层并接管键盘）。

> **这是插件半，只有插件不能用。** 桌面层、隐藏图标、打字切换、开机自启、托盘这些网页做不到的事由**原生宿主包**提供。
>
> **插件就在发行包里，不需要从 npm 装。** 下载 [Release](https://github.com/wellorbetter/dsh-desktop-mode/releases) 的 `dsh-desktop-mode-v<版本>.zip`，解压后跑 `host\install.cmd` —— 它会把这个插件装进你的 DSH，同时装好原生工具、注册开机自启。没有 npm、没有网络、没有编译器要求。

## 手动装（一般不需要）

宿主已经装好、只想自己装插件时，用发行包里那份的绝对路径：

```powershell
dsh plugin --profile web add link:"C:\Users\<你>\AppData\Local\dsh-desktop-mode\plugin"
```

## 它做了什么

- 在 DSH 页面里挂一层挂件（时钟 / 日期 / 星期 / 手写文字 / 天气 / fps），配置来自宿主安装目录的 `widgets.json`；
- 壁纸换了就重新取色，深色壁纸用白字、浅色壁纸用黑字；
- 点 DSH 的输入框时把窗口临时从桌面层提到前台并接管键盘，失焦 / Esc / 点到别处就还回去；抢不到键盘就退回桌面层，不留一个"看着能打字其实打不了"的窗口。

## 排错

- 页面上没有挂件：确认宿主装好了（`%LOCALAPPDATA%\dsh-desktop-mode\config.json` 存在，且里面 `shellExe` 指向你的 DSH 壳），然后重启 DSH。
- 挂件配置改了没生效：改的是宿主安装目录里的 `widgets.json`，改完刷新页面。
- 点输入框没反应：原生工具没起来，跑 `%LOCALAPPDATA%\dsh-desktop-mode\tools\dsh-desktop.ps1 status` 看状态。

## 许可

MIT
