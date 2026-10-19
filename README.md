# dsh-plugin-win-control

Windows 桌面 + Chromium 页面控制插件（DSH / cordis）。一条设计约束贯穿全部：**用户还在用这台电脑**。默认路径不移动光标、不抢焦点、不置前窗口；只有显式标记为侵入的工具才会抢焦点。

## 二十个工具

### 只读 / 无侵入（推荐默认）

| 工具 | 作用 | 实测延迟 |
|---|---|---|
| `win_list_windows` | 枚举顶层窗口（标题/类名/pid/exe/矩形/前台标记） | 3-20 ms |
| `win_window_info` / `win_screen_info` | 单窗口详情 + 光标 / 屏幕尺寸 | <2 ms |
| `win_uia_tree` / `win_uia_find` | UI Automation 控件树 / 按条件查控件 | 10-300 ms |
| `win_capture` | PrintWindow 离屏截图（被遮挡、最小化也能截） | 11-40 ms |
| `cdp_snapshot` | 页面结构化快照：可交互元素 + 可见文本 + 稳定 CSS ref | 首调 ~500 ms，之后 3-20 ms |
| `cdp_eval` | 在页面里求值并返回 JSON | 3-10 ms |
| `cdp_screenshot` | CDP 渲染侧截图（窗口不可见也行） | 30-150 ms |
| `cdp_targets` | 列出某个调试端口上的页面目标 | ~10 ms |

### 无侵入操作（不抢键鼠）

| 工具 | 作用 | 实测延迟 |
|---|---|---|
| `win_uia_invoke` | 用控件自身 pattern 触发（Invoke/SelectionItem/Toggle） | 10-40 ms |
| `win_uia_set_value` | ValuePattern 写值 | 10-40 ms |
| `win_click` | PostMessage 点击（坐标沿子窗口链下钻） | <1 ms |
| `win_type_text` | PostMessage WM_CHAR 打字 | <1 ms |
| `cdp_click` | 页面内派发指针/鼠标事件 | 3-10 ms |
| `cdp_type` | 用原生 setter 写值 + input/change 事件（React/Vue 可用） | 3-10 ms |

### 显式侵入（会抢焦点，按需使用）

| 工具 | 作用 | 说明 |
|---|---|---|
| `cdp_launch` / `cdp_close` | 起/停一个隔离 Chromium（独立临时 profile + 调试端口） | 不影响用户自己的浏览器 |
| `win_activate` | `ShowWindow(SW_RESTORE)` + `SetForegroundWindow` | **抢焦点** |
| `win_send_keys` | `mode: post` 安全投递；`mode: input` 用 `SendInput` 真注入 | **input 模式抢焦点** |

## 为什么低冲突

- 读取全部是 Win32 查询 / UI Automation 客户端 / 页面内 JS，**不注入输入**。
- `win_click` / `win_type_text` 用 `PostMessage`：光标不动、不抢焦点。
- `cdp_*` 走渲染进程：连 OS 输入队列都不经过，天然与用户操作隔离。
- `win_activate` 和 `win_send_keys{mode:'input'}` 是唯一会改变前台窗口的两条路径，工具描述里已标 **HIGH IMPACT**，不做任何隐式回退。

## 架构

```
lib/index.js        20 个 defineTool + Config + 随包 skill 注册
lib/native.js       koffi -> user32/kernel32/gdi32（枚举/几何/PrintWindow）
lib/input.js        PostMessage 点击 / WM_CHAR 打字
lib/keys.js         窗口激活 + 双通道按键（post / SendInput）
lib/uia-worker.ps1  常驻 PowerShell + UI Automation worker（JSON 行协议）
lib/uia.js          worker 客户端（串行队列、超时、崩溃消息）
lib/cdp.js          Chrome DevTools Protocol 客户端（ws + 页面内函数序列化）
lib/png.js          零依赖 PNG 编码
```

### 三个关键取舍

1. **UIA 用常驻 worker**：每次 spawn PowerShell 是 ~250 ms，常驻后单次 10-40 ms。
2. **高频读走 koffi 进程内调用**：枚举窗口 3-20 ms，比任何外部进程方案快一个数量级。
3. **CDP 页面内函数用 `Function.prototype.toString()` 注入**：不用拼字符串转义，函数直接写成普通 JS，避免注入串的引号地狱。

## CDP 用法（页面精确操作）

```text
cdp_launch  { url: 'https://example.com' }          -> port 5370
cdp_snapshot{ port: 5370 }                          -> interactive[] + text_blocks[]
cdp_type    { port: 5370, selector: '<ref>', text: 'x' }
cdp_click   { port: 5370, selector: '<ref>' }       或 { text: '登录' }
cdp_close   { port: 5370 }
```

`cdp_launch` 起的是**独立实例**：临时 user-data-dir（`%TEMP%\dsh-win-cdp-*`），和你正在用的 Chrome 完全隔离；关闭时连同 profile 一起删。

要接**已在运行**的 Chromium/Electron，必须它自己带 `--remote-debugging-port`；插件会去读 `http://127.0.0.1:<port>/json/list`，不猜端口。

## 按键语法

`Enter` `Tab` `Esc` `Space` `Backspace` `Delete` `Home` `End` `PageUp` `PageDown` `Up` `Down` `Left` `Right` `F1..F12` `A..Z` `0..9`，组合用 `+`：`Ctrl+A`、`Shift+Tab`、`Ctrl+Shift+Esc`。

- `mode: 'post'`（默认）：投递给窗口当前焦点控件，用户键盘不受影响。
- `mode: 'input'`：先激活窗口再 `SendInput`，等价于真的按下；用于忽略 posted 消息的应用。

## 实测（Ryzen 5 5600X / Win11 22631）

```
枚举 1700 个顶层窗口（含 exe 解析）     5-20 ms
PrintWindow 抓 1936x1048               11-40 ms
UIA 读 explorer 控件树 231 节点        1.3 s（跨进程 UIA 固有开销，用 max_nodes 收敛）
UIA 读 Electron 窗口原生框架            ~200 ms（拿不到网页内容 -> 用 CDP）
cdp_snapshot（热）                      3-20 ms
cdp_click / cdp_type                    3-10 ms
PostMessage 点击/打字                   <1 ms
SendInput 按键                          <1 ms（但抢焦点）
```

## 输出契约（重要）

DSH 会校验每个工具返回值是不是 **lossless JSON**：对象里残留 `undefined`、
`NaN`/`Infinity`、或落单的 UTF-16 surrogate 都会被判为 `invalid output` 而整次调用失败。
本插件所有返回值统一走 `compact()` 兜掉 `undefined` 字段，`test/contracts.mjs` 会真的
逐个工具跑一遍并做 JSON 往返校验 —— 改完任何 tool 的 return 都跑它：

```
cd %USERPROFILE%\.dsh\plugins\dsh-plugin-win-control
node test\contracts.mjs
```

## 改完代码怎么生效（免重启）

`lib/*.js` 被 ESM 模块缓存住，改文件不会热更；但 `cordis.patch.yml` 是 live 重载的，
而模块 URL 带 query 就是不同的模块实例。所以：

1. 先把挂载项删掉（等 2~3 秒，工具消失）
2. 再用新的 `?v=<时间戳>` 加回来

```yaml
- insert:
    - id: win-control
      name: 'file:///C:/Users/<you>/.dsh/plugins/dsh-plugin-win-control/lib/index.js?v=1792348562751'
      config:
        captureKeep: 200
        uiaMaxNodes: 400
        cdpPort: 9222
        cdpTimeoutMs: 10000
```

只改 `name` 的 query 不会触发重新 import（loader 视为配置变更），必须先摘再挂。
`test\hot-reload.mjs` 把这两步做成了脚本：`node test\hot-reload.mjs`。

## 变更记录

- **0.2.2** 所有工具返回值改为 lossless JSON（`compact()` 去掉 `undefined`）；
  `cdp_launch` 对 `file://` 页面按 pathname 判就绪（此前会抓在 `about:blank` 上）；
  新增 `test/contracts.mjs` 输出契约回归、`test/hot-reload.mjs` 免重启换载。
- **0.2.1** `cdp_launch` 等到目标 URL 就绪再回填 `title/url/ready_state`；
  过滤 `TabProxyWindow` 幽灵窗口；随包 SKILL.md。

## 已知限制

1. **Electron/Chrome 的 UIA 树只有原生框架**：网页内容请用 `cdp_*`（需要调试端口）或 `win_capture` + `win_click` 点坐标。
2. **WinForms / 老 Win32 控件没有现代 UIA pattern**：`win_uia_invoke` 会明确报失败，改用 `win_click` + `win_type_text`（已在本机 WinForms 测试窗上验证）。
3. **屏幕锁定时** `GetForegroundWindow` / `GetCursorPos` 返回 0，截图仍可用。
4. **忽略 PostMessage 的应用**（DirectInput 游戏等）不响应安全通道，需要 `win_send_keys{mode:'input'}`，且会抢焦点。
5. **`cdp_launch` 只起 Chromium 系浏览器**；Electron 应用需要它自身开启调试端口才能接。
6. 32 位（WoW64）目标进程通常拿不到 UIA 树。

## 配置

```yaml
captureDir:    截图目录，默认 %TEMP%\dsh-win-control
captureKeep:   保留最近 N 张，默认 200
uiaMaxNodes:   win_uia_tree 默认节点预算，默认 400
uiaTimeoutMs:  UIA 单次超时，默认 20000
powershellPath: 自定义 PowerShell
cdpPort:       cdp_* 默认调试端口，默认 9222
cdpTimeoutMs:  CDP 超时，默认 10000
browserPath:   cdp_launch 用的浏览器，默认自动探测 Chrome/Edge
provideSkill:  是否注册随包 skill，默认 true
```

## 安装

### 依赖

运行时依赖只有三个，且 DSH 里通常已经有：

```
koffi                        Win32 FFI（插件必需）
ws                           CDP 用的 WebSocket（只有 cdp_* 需要）
@deepseek-ai/dsh-tools       defineTool
@deepseek-ai/schemastery     Config
```

不用 `npm install`，直接从 DSH profile 链过来即可（Windows junction）：

```bat
cd /d %USERPROFILE%\.dsh\plugins\dsh-plugin-win-control
mklink /J node_modules\koffi                       %USERPROFILE%\.dsh\profiles\node_modules\koffi
mklink /J node_modules\ws                          %USERPROFILE%\.dsh\profiles\desktop\node_modules\ws
mklink /J node_modules\@deepseek-ai                %USERPROFILE%\.dsh\profiles\node_modules\@deepseek-ai
```

（Linux/macOS 上用 `ln -s`；本插件本身只支持 Windows。）

### 挂载

在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: win-control
      name: 'file:///C:/Users/<you>/.dsh/plugins/dsh-plugin-win-control/lib/index.js'
      config:
        captureKeep: 200
        uiaMaxNodes: 400
        cdpPort: 9222
        cdpTimeoutMs: 10000
```

注意：**改 `lib/*.js` 需要重启 DSH**（或用上面的 `test\hot-reload.mjs` 免重启换载）；改 patch 配置则即时生效。

### 自检

```bat
node test\registry.mjs    :: 20 个工具 + skill 是否都注册上了
node test\contracts.mjs   :: 返回值是否都是 lossless JSON
```

## 测试

```bat
cd /d %USERPROFILE%\.dsh\plugins\dsh-plugin-win-control

node test\registry.mjs           :: 20 个工具 + skill 的注册自检
node test\contracts.mjs          :: 每个工具的返回值都是 lossless JSON
node test\smoke.mjs              :: 窗口 / UIA / 截图冒烟
node test\e2e-winforms.mjs       :: WinForms：UIA + PostMessage 点击 / 打字
node test\e2e-keys.mjs           :: 激活 + 双通道按键（底层）
node test\e2e-keys-tools.mjs     :: 同上，走工具层
node test\e2e-cdp.mjs            :: CDP 底层：snapshot / click / type / screenshot
node test\e2e-cdp-tools.mjs      :: CDP 工具层完整链路
node test\e2e-cdp-launch.mjs     :: cdp_launch 必须回填已加载的页面（竞态回归）
```

全部 9 个套件在本机 Win11 22631 / Node 20.19.3 上是绿的。测试会真的起窗口、起 Chromium：
`e2e-winforms` 用 `test-target.ps1` 开一个 WinForms 测试窗，`e2e-keys` 会短暂激活它。

## License

MIT，见 [LICENSE](LICENSE)。
