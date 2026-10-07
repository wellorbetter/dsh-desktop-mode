# DSH Desktop Mode (dsh-desktop-mode)

Turns **DeepSeek Harness into your Windows desktop**: the DSH UI fills the screen, your clock / date / handwritten caption / weather / fps widgets sit on the wallpaper, and **clicking an input box lets you type right there** — yielding to any other window the moment it needs the keyboard.

It ships as two halves (not a choice, a division of labour):

- **the DSH plugin** (`dsh-plugin-desktop-mode`) — everything inside the page: the widget layer, the typing trigger, and the host routes that call the native tool;
- **the native host** (`host/` and `tools/` in this repo) — what a web page cannot do: pinning the window into Explorer's desktop, hiding icons, leaving/returning the desktop layer to take the keyboard, autostart, tray.

> This repository contains **no copy of any third-party desktop app**. The installer finds the one you already have, or unpacks `desktop.zip` for you.

## Requirements

| | |
|---|---|
| OS | Windows 10 / 11 |
| DSH | anything that can run `dsh web` (web profile, kernel ≥ 0.1.5) |
| Host app | a desktop shell that loads the DSH web UI into a window: the official desktop app, DSH Desktop ≥ 2.0.7, or the wallpaper plugin's desktop build |
| Optional | `dsh-plugin-wallpaper-engine` (the wallpaper; without it the desktop is a solid background plus widgets) |

## Install

1. Download `dsh-desktop-mode-v<version>.zip` from Releases and extract it.
2. Run `host\install.cmd` (or `pwsh -File host\install.ps1`) — note it lives in the `host\` subdirectory. It will:
   - locate the host app (or tell you to pass `-ShellExe "<path to exe>"`);
   - install the tooling into `%LOCALAPPDATA%\dsh-desktop-mode`;
   - install the plugin (from npm by default; `-FromLocal` for offline/local development);
   - register autostart and start the layer.
3. The desktop becomes DSH.

Useful flags: `-ShellExe` · `-FromLocal` · `-SkipAutostart` · `-SkipStart` · `-WhatIf` (plan only, change nothing).

## Uninstall

`host\uninstall.cmd`: stop the layer → restore the normal desktop → remove autostart → remove the plugin → delete the install directory.
Your widget configuration is kept as `widgets.json.bak` unless you pass `-Purge`.

## Usage

- **Typing**: click an input box on the desktop and type. `Esc`, or clicking anywhere else, puts the layer back.
  **Safety rail**: the keyboard is only ever taken when the desktop already owns the foreground — it can never steal it from a game or another application.
- **Tray**: status · reload widgets · show/hide desktop icons · typing mode · back to the desktop layer · stop.
- **Configuration**: `%LOCALAPPDATA%\dsh-desktop-mode\widgets.json` (clock position, caption text, weather badge, fps, character art, adaptive colour, …). Reload the page after editing.
- **Commands** (in the install directory): `tools\dsh-desktop.ps1` with `start` / `stop` / `status` / `typing-on` / `typing-off` / `fill` / `icons-off` / `tray-reload`.

## How it works

- Windows delivers keyboard input only to the input queue of the **foreground** window's thread, and a window parented into Explorer's desktop view is a child window that can **never** be the foreground window. Typing on the desktop therefore requires *leaving* the desktop layer: the window turns from a desktop child back into an ordinary top-level window (identical geometry, no frame — visually indistinguishable) → it takes the keyboard → it is parented back as soon as you click away.
- That round trip makes Windows rebuild the window's composition identity, which leaves one or two frames where neither surface is shown ⇒ a **freeze mask** covers the swap with the last frame for ~160 ms.
- Text colour is chosen per block from the luminance of the wallpaper **behind that block** (white on dark, black on light), with hysteresis so a video wallpaper cannot make it flicker.

## Privacy

Everything runs locally: the plugin's routes serve the local page only (`127.0.0.1`), nothing is uploaded, and your conversations are never read. The native tool only manipulates windows (`SetParent` / focus / icons); the single system write is the autostart entry under `HKCU\...\Run`, removed on uninstall.

## Known limitations

- Desktop icons are hidden by default (the icon list would otherwise cover the layer); `icons-on` shows them explicitly.
- Windows 11 files new tray icons under "hidden icons"; drag it onto the taskbar to pin it.
- The executables are unsigned, so SmartScreen may warn.
- With an auto-hidden taskbar: the layer covers the whole screen, so moving the pointer to the bottom edge returns to the desktop layer first and the taskbar appears right after (by design).

## Development

- **Plugin**: `plugin/` — host `lib/index.js`, client `lib/client.js`, widgets `lib/widgets/`, typing `lib/typing.js`.
  Local install: `dsh plugin --profile web add link:<absolute path>`.
- **Native tool**: `tools/native/dsh-desktop-input.cs`, built by `tools/build-input-helper.ps1` (the in-box .NET Framework compiler is C# 5, so the source avoids tuples, `out var` and string interpolation).
- **Release**: `pwsh -File packaging/build-release.ps1` — compiles the tool, copies `host/` `tools/` `plugin/`, and **asserts** the package contains no `shell/`, `logs/`, `state/` or `.evidence/`.
- **Tray icon**: `tools/make-icon.ps1` generates `tools/bin/dsh-desktop.ico` (self-made, no third-party asset).
- **Tests**: `node test/widget-config.mjs` - the widget-configuration validation contract.

## License

MIT
