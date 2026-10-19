---
name: win-control
description: Use when operating the local Windows desktop or a Chromium page through the win_* / cdp_* tools (dsh-plugin-win-control) — enumerate windows, read UI Automation trees, invoke controls, click and type without stealing the user's mouse or keyboard, launch an isolated browser and drive its DOM, and capture windows or pages offscreen.
---

# win-control — 低冲突 Windows 桌面与页面操作

前提：**用户还在用这台电脑**。默认路径不移动光标、不抢焦点。先读，再动；能走无侵入通道就不要走侵入通道。

## 先选通道

| 目标 | 用 | 为什么 |
|---|---|---|
| 网页（Chrome / Electron） | `cdp_*` | 毫秒级、元素级、完全不碰 OS 输入 |
| 传统桌面应用（资源管理器、WPF、UWP） | `win_uia_*` | 有控件树，能精确 invoke |
| WinForms / 老 Win32 | `win_click` + `win_type_text` | 控件没有 pattern，按坐标 PostMessage 也不抢焦点 |
| 自绘界面 / 游戏 / 截图看画面 | `win_capture`（再看情况 `win_click`） | 没有树，只能看图 |
| 只有真按键才行的场景 | `win_send_keys{mode:'input'}` | **抢焦点**，最后手段 |

## 桌面流程

1. `win_list_windows`（按标题/exe 过滤）拿 hwnd。
2. `win_uia_tree`（`max_depth`/`max_nodes` 收敛）或 `win_uia_find` 定位控件。
3. 有 `<Invoke>`/`<SelectionItem>`/`<Toggle>` → `win_uia_invoke`；有 `<Value>` → `win_uia_set_value`。
4. 没有 pattern → `win_click`（UIA 节点 rect 中心，screen 坐标）+ `win_type_text`（带 `at_x/at_y`）。
5. 需要特殊键（Tab、方向键、F 键、组合键）→ `win_send_keys`，先 `mode:'post'`。
6. 每次操作后重新 `win_uia_tree` 或 `win_capture` 确认，不要假设成功。

## 网页流程

1. 需要自己起浏览器 → `cdp_launch {url}`（独立临时 profile，不动用户浏览器）；否则 `cdp_targets {port}` 看有没有现成调试端口。
2. `cdp_snapshot` 拿 `interactive[]`：`ref` 是稳定 CSS 路径，`text`/`value`/`placeholder` 帮你认出元素。
3. `cdp_click {selector: ref}` 或 `{text: '登录'}`；`cdp_type {selector, text}` 写输入框（原生 setter，React/Vue 也能收到）。
4. 需要更细的页面状态 → `cdp_eval {expression}`。
5. 截图 → `cdp_screenshot`（窗口不可见也有效）。
6. 结束 → `cdp_close {port}`。

## 关键事实（踩过坑）

- **Electron/Chrome 的 UIA 树只有原生框架**（标题栏按钮）。网页内容一律走 CDP；没有调试端口才退回 `win_capture` + `win_click`。
- **WinForms / 老 Win32 控件**以 `Pane` 出现且 pattern 为空，`win_uia_invoke` 会明确报「没有可用 pattern」。改用 `win_click` + `win_type_text`。
- `win_capture` 对**最小化/被遮挡**窗口有效；`cdp_screenshot` 对**后台页面**有效。
- 屏幕**锁定**时 `foreground`/`cursor` 是 0，这是 Windows 行为。
- `win_click` / `win_type_text` 对**忽略 PostMessage** 的应用无效（DirectInput 游戏、部分自绘 UI）；这是不抢输入的代价。
- `cdp_launch` 只起 Chromium 系；**接现有 Electron 需要它自己带 `--remote-debugging-port`**，插件不猜端口。
- UIA worker 与 CDP 连接都是串行/缓存的：同一端口复用连接，别反复 cdp_launch。

## 反模式

- 不要为了「保险」先 `win_activate`；它会立刻打断用户。
- 不要用 `cdp_launch` 去操作**用户正在用的**浏览器窗口——那会开新实例而不是接管旧的。
- 不要对同一窗口反复扫全量 UIA 树（explorer 一棵 200+ 节点要 1s 级）；用 `win_uia_find`。
- 不要在 `cdp_type` 里用 `Input.insertText` 绕过框架（部分受控组件不认）；插件已用原生 setter + input/change。
