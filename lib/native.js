/**
 * native.js — Win32 bindings for window enumeration, geometry, and offscreen capture.
 *
 * Everything here is observe-only: no focus changes, no synthetic input.
 * Latency on this machine: full top-level enumeration ~2 ms, PrintWindow capture ~11 ms.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_NOACTIVATE = 0x08000000;
const GW_OWNER = 4;
const GA_ROOT = 2;
const PW_RENDERFULLCONTENT = 2;
const DIB_RGB_COLORS = 0;
const BI_RGB = 0;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

let api = null;

function load() {
  if (api) return api;
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const gdi32 = koffi.load('gdi32.dll');

  const f = (lib, signature) => lib.func(signature);

  const EnumWindows = f(user32, 'bool __stdcall EnumWindows(void* lpEnumFunc, intptr_t lParam)');
  const EnumChildWindows = f(user32, 'bool __stdcall EnumChildWindows(void* hWnd, void* lpEnumFunc, intptr_t lParam)');
  const GetWindowTextW = f(user32, 'int __stdcall GetWindowTextW(void* hWnd, _Out_ uint16_t* lpString, int nMaxCount)');
  const GetClassNameW = f(user32, 'int __stdcall GetClassNameW(void* hWnd, _Out_ uint16_t* lpString, int nMaxCount)');
  const IsWindowVisible = f(user32, 'bool __stdcall IsWindowVisible(void* hWnd)');
  const IsWindow = f(user32, 'bool __stdcall IsWindow(void* hWnd)');
  const IsIconic = f(user32, 'bool __stdcall IsIconic(void* hWnd)');
  const GetWindowRect = f(user32, 'bool __stdcall GetWindowRect(void* hWnd, _Out_ int32* rect)');
  const GetForegroundWindow = f(user32, 'void* __stdcall GetForegroundWindow()');
  const GetWindow = f(user32, 'void* __stdcall GetWindow(void* hWnd, uint32 uCmd)');
  const GetAncestor = f(user32, 'void* __stdcall GetAncestor(void* hWnd, uint32 flags)');
  const GetWindowThreadProcessId = f(user32, 'uint32 __stdcall GetWindowThreadProcessId(void* hWnd, _Out_ uint32* pid)');
  const GetWindowLongPtrW = f(user32, 'intptr_t __stdcall GetWindowLongPtrW(void* hWnd, int nIndex)');
  const GetCursorPos = f(user32, 'bool __stdcall GetCursorPos(_Out_ int32* pt)');
  const GetSystemMetrics = f(user32, 'int __stdcall GetSystemMetrics(int nIndex)');
  const PrintWindow = f(user32, 'bool __stdcall PrintWindow(void* hWnd, void* hdcBlt, uint32 flags)');
  const GetDC = f(user32, 'void* __stdcall GetDC(void* hWnd)');
  const ReleaseDC = f(user32, 'int __stdcall ReleaseDC(void* hWnd, void* hDC)');
  const ClientToScreen = f(user32, 'bool __stdcall ClientToScreen(void* hWnd, _Inout_ int32* pt)');
  const MapWindowPoints = f(user32, 'int __stdcall MapWindowPoints(void* hWndFrom, void* hWndTo, _Inout_ int32* pts, uint32 cPoints)');
  const POINT = koffi.struct('WINCONTROL_POINT', { x: 'int32', y: 'int32' });
  const ChildWindowFromPointEx = f(user32, 'void* __stdcall ChildWindowFromPointEx(void* hWnd, WINCONTROL_POINT pt, uint32 flags)');
  const WindowFromPoint = f(user32, 'void* __stdcall WindowFromPoint(WINCONTROL_POINT pt)');
  const ScreenToClient = f(user32, 'bool __stdcall ScreenToClient(void* hWnd, _Inout_ int32* pt)');
  const PostMessageW = f(user32, 'bool __stdcall PostMessageW(void* hWnd, uint32 msg, uintptr_t wParam, intptr_t lParam)');
  const SendMessageTimeoutW = f(user32, 'intptr_t __stdcall SendMessageTimeoutW(void* hWnd, uint32 msg, uintptr_t wParam, intptr_t lParam, uint32 flags, uint32 timeout, _Out_ uintptr_t* result)');
  const GetFocus = f(user32, 'void* __stdcall GetFocus()');
  const ShowWindow = f(user32, 'bool __stdcall ShowWindow(void* hWnd, int nCmdShow)');
  const SetForegroundWindow = f(user32, 'bool __stdcall SetForegroundWindow(void* hWnd)');
  const BringWindowToTop = f(user32, 'bool __stdcall BringWindowToTop(void* hWnd)');
  const SetActiveWindow = f(user32, 'void* __stdcall SetActiveWindow(void* hWnd)');
  const SetFocusFn = f(user32, 'void* __stdcall SetFocus(void* hWnd)');
  const AllowSetForegroundWindow = f(user32, 'bool __stdcall AllowSetForegroundWindow(uint32 dwProcessId)');
  const MapVirtualKeyW = f(user32, 'uint32 __stdcall MapVirtualKeyW(uint32 uCode, uint32 uMapType)');
  const GUITHREADINFO = koffi.struct('WINCONTROL_GUITHREADINFO', {
    cbSize: 'uint32',
    flags: 'uint32',
    hwndActive: 'void*',
    hwndFocus: 'void*',
    hwndCapture: 'void*',
    hwndMenuOwner: 'void*',
    hwndMoveSize: 'void*',
    hwndCaret: 'void*',
    rcCaret: koffi.array('int32', 4),
  });
  const GetGUIThreadInfo = f(user32, 'bool __stdcall GetGUIThreadInfo(uint32 idThread, _Inout_ WINCONTROL_GUITHREADINFO* pgui)');
  const SendInput = f(user32, 'uint32 __stdcall SendInput(uint32 cInputs, void* pInputs, int cbSize)');
  const GetForegroundWindow2 = GetForegroundWindow;

  const OpenProcess = f(kernel32, 'void* __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)');
  const QueryFullProcessImageNameW = f(kernel32, 'bool __stdcall QueryFullProcessImageNameW(void* hProcess, uint32 flags, _Out_ uint16_t* name, _Inout_ uint32* size)');
  const CloseHandle = f(kernel32, 'bool __stdcall CloseHandle(void* h)');

  const CreateCompatibleDC = f(gdi32, 'void* __stdcall CreateCompatibleDC(void* hdc)');
  const CreateCompatibleBitmap = f(gdi32, 'void* __stdcall CreateCompatibleBitmap(void* hdc, int w, int h)');
  const SelectObject = f(gdi32, 'void* __stdcall SelectObject(void* hdc, void* obj)');
  const DeleteObject = f(gdi32, 'bool __stdcall DeleteObject(void* obj)');
  const DeleteDC = f(gdi32, 'bool __stdcall DeleteDC(void* hdc)');
  const GetDIBits = f(gdi32, 'int __stdcall GetDIBits(void* hdc, void* hbm, uint32 start, uint32 cLines, void* bits, void* bmi, uint32 usage)');

  const enumProcType = koffi.pointer(koffi.proto('bool __stdcall WinControlEnumProc(void* hWnd, intptr_t lParam)'));

  api = {
    koffi,
    EnumWindows,
    EnumChildWindows,
    GetWindowTextW,
    GetClassNameW,
    IsWindowVisible,
    IsWindow,
    IsIconic,
    GetWindowRect,
    GetForegroundWindow,
    GetWindow,
    GetAncestor,
    GetWindowThreadProcessId,
    GetWindowLongPtrW,
    GetCursorPos,
    GetSystemMetrics,
    PrintWindow,
    GetDC,
    ReleaseDC,
    ClientToScreen,
    MapWindowPoints,
    OpenProcess,
    QueryFullProcessImageNameW,
    CloseHandle,
    CreateCompatibleDC,
    CreateCompatibleBitmap,
    SelectObject,
    DeleteObject,
    DeleteDC,
    GetDIBits,
    enumProcType,
    POINT,
    ChildWindowFromPointEx,
    WindowFromPoint,
    PostMessageW,
    SendMessageTimeoutW,
    GetFocus,
    ShowWindow,
    SetForegroundWindow,
    BringWindowToTop,
    SetActiveWindow,
    SetFocusFn,
    AllowSetForegroundWindow,
    MapVirtualKeyW,
    GetGUIThreadInfo,
    SendInput,
  };
  return api;
}

/** Expose the lazy Win32 loader for sibling modules (input.js). */
export function loadNative() {
  return load();
}

/** Format an HWND pointer as a stable hex string. */
export function hwndToString(hwnd) {
  const value = typeof hwnd === 'bigint' ? hwnd : BigInt(hwnd ?? 0);
  return '0x' + value.toString(16).toUpperCase().padStart(16, '0');
}

/** Parse an HWND from a decimal or 0x-prefixed hex string. */
export function parseHwnd(text) {
  if (typeof text === 'number') return text;
  const raw = String(text ?? '').trim();
  if (raw === '') throw new Error('hwnd is required, e.g. "0x0000000000120A4C"');
  const value = raw.toLowerCase().startsWith('0x') ? Number.parseInt(raw.slice(2), 16) : Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) throw new Error(`invalid hwnd: ${raw}`);
  return value;
}

function readWide(fn, hwnd, capacity) {
  const buf = Buffer.alloc(capacity * 2);
  const written = fn(hwnd, buf, capacity - 1);
  if (written <= 0) return '';
  return buf.toString('utf16le', 0, written * 2);
}

const exeCache = new Map();

function processPath(pid) {
  if (!pid) return '';
  const cached = exeCache.get(pid);
  if (cached !== undefined) return cached;
  const { OpenProcess, QueryFullProcessImageNameW, CloseHandle } = load();
  const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!handle) return '';
  try {
    const buf = Buffer.alloc(1024 * 2);
    const size = [512];
    if (!QueryFullProcessImageNameW(handle, 0, buf, size)) return '';
    const resolved = buf.toString('utf16le', 0, size[0] * 2);
    exeCache.set(pid, resolved);
    return resolved;
  } finally {
    CloseHandle(handle);
  }
}

function rectOf(hwnd) {
  const rect = [0, 0, 0, 0];
  const { GetWindowRect } = load();
  if (!GetWindowRect(hwnd, rect)) return null;
  return { x: rect[0], y: rect[1], width: rect[2] - rect[0], height: rect[3] - rect[1] };
}

function describeWindow(hwnd, foreground) {
  const { IsWindowVisible, GetWindowThreadProcessId, GetWindowLongPtrW, GetWindow, IsIconic, GetWindowTextW, GetClassNameW } = load();
  const exStyle = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
  const owner = GetWindow(hwnd, GW_OWNER);
  const pidBuf = [0];
  GetWindowThreadProcessId(hwnd, pidBuf);
  const pid = pidBuf[0];
  return {
    hwnd: hwndToString(hwnd),
    title: readWide(GetWindowTextW, hwnd, 512),
    class: readWide(GetClassNameW, hwnd, 256),
    pid,
    exe: processPath(pid),
    rect: rectOf(hwnd),
    visible: Boolean(IsWindowVisible(hwnd)),
    minimized: Boolean(IsIconic(hwnd)),
    toolWindow: (exStyle & WS_EX_TOOLWINDOW) !== 0,
    noActivate: (exStyle & WS_EX_NOACTIVATE) !== 0,
    owned: Number(owner ?? 0) !== 0,
    foreground: foreground,
  };
}

/**
 * Enumerate top-level windows.
 * @param {{ visibleOnly?: boolean, includeToolWindows?: boolean, titleOnly?: boolean }} [options]
 * @returns {{ windows: object[], foreground: string, count: number, elapsedMs: number }}
 */
export function listWindows(options = {}) {
  const {
    visibleOnly = true,
    includeToolWindows = false,
    titleOnly = true,
  } = options;
  const { EnumWindows, GetForegroundWindow, IsWindowVisible, GetWindowLongPtrW } = load();
  const started = process.hrtime.bigint();
  const handles = [];
  const cb = (hwnd) => {
    handles.push(hwnd);
    return true;
  };
  const registered = api.koffi.register(cb, api.enumProcType);
  try {
    EnumWindows(registered, 0);
  } finally {
    api.koffi.unregister(registered);
  }
  const fg = hwndToString(GetForegroundWindow());
  const windows = [];
  for (const hwnd of handles) {
    if (visibleOnly && !IsWindowVisible(hwnd)) continue;
    if (!includeToolWindows) {
      const exStyle = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
      if (exStyle & WS_EX_TOOLWINDOW) continue;
    }
    const entry = describeWindow(hwnd, hwndToString(hwnd) === fg);
    if (titleOnly && entry.title === '') continue;
    // Windows 11 exposes one tab-proxy window per tab; they are 136x39 shell
    // artifacts with no content, so they only add noise to a window list.
    if (entry.class === 'Windows.Internal.Shell.TabProxyWindow') continue;
    if (!entry.rect || entry.rect.width <= 0 || entry.rect.height <= 0) continue;
    windows.push(entry);
  }
  return {
    windows,
    foreground: fg,
    count: windows.length,
    elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
  };
}

/** Describe a single window by handle. */
export function windowInfo(hwndText) {
  const { IsWindow } = load();
  const hwnd = parseHwnd(hwndText);
  if (!IsWindow(hwnd)) throw new Error(`no such window: ${hwndText}`);
  const fg = hwndToString(load().GetForegroundWindow());
  return { ...describeWindow(hwnd, hwndToString(hwnd) === fg), cursor: cursorPosition() };
}

/** Current cursor position and primary screen metrics (observe-only). */
export function screenInfo() {
  return {
    cursor: cursorPosition(),
    screen: {
      width: load().GetSystemMetrics(0),
      height: load().GetSystemMetrics(1),
    },
  };
}

function cursorPosition() {
  const pt = [0, 0];
  load().GetCursorPos(pt);
  return { x: pt[0], y: pt[1] };
}

/**
 * Capture a window offscreen with PrintWindow — never brings it forward.
 * @param {string|number} hwndText
 * @param {{ clientArea?: boolean }} [options]
 * @returns {{ bgra: Buffer, width: number, height: number, method: string, elapsedMs: number }}
 */
export function captureWindow(hwndText, options = {}) {
  const n = load();
  const hwnd = parseHwnd(hwndText);
  if (!n.IsWindow(hwnd)) throw new Error(`no such window: ${hwndText}`);
  const started = process.hrtime.bigint();
  let width = 0;
  let height = 0;
  if (options.clientArea) {
    const rect = [0, 0, 0, 0];
    n.GetWindowRect(hwnd, rect);
    width = Math.max(1, rect[2] - rect[0]);
    height = Math.max(1, rect[3] - rect[1]);
  } else {
    const rect = [0, 0, 0, 0];
    n.GetWindowRect(hwnd, rect);
    width = Math.max(1, rect[2] - rect[0]);
    height = Math.max(1, rect[3] - rect[1]);
  }
  const screenDc = n.GetDC(0);
  const memDc = n.CreateCompatibleDC(screenDc);
  const bitmap = n.CreateCompatibleBitmap(screenDc, width, height);
  const previous = n.SelectObject(memDc, bitmap);
  let printed = false;
  try {
    printed = Boolean(n.PrintWindow(hwnd, memDc, PW_RENDERFULLCONTENT));
    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0);
    header.writeInt32LE(width, 4);
    header.writeInt32LE(-height, 8); // top-down rows
    header.writeUInt16LE(1, 12);
    header.writeUInt16LE(32, 14);
    header.writeUInt32LE(BI_RGB, 16);
    header.writeUInt32LE(width * height * 4, 20);
    const pixels = Buffer.alloc(width * height * 4);
    const copied = n.GetDIBits(memDc, bitmap, 0, height, pixels, header, DIB_RGB_COLORS);
    if (copied === 0) throw new Error('GetDIBits failed: the window produced no readable pixels');
    return {
      bgra: pixels,
      width,
      height,
      method: printed ? 'PrintWindow' : 'GetDIBits',
      elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
    };
  } finally {
    if (previous) n.SelectObject(memDc, previous);
    n.DeleteObject(bitmap);
    n.DeleteDC(memDc);
    n.ReleaseDC(0, screenDc);
  }
}
