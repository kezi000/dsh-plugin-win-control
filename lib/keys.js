/**
 * keys.js - window activation and keystrokes.
 *
 * Two clearly separated lanes:
 *
 *   post  (default) - WM_KEYDOWN/WM_KEYUP/WM_CHAR delivered to the window's focus
 *                     control. The user keeps the keyboard; nothing global happens.
 *   input (opt-in)  - SetForegroundWindow + SendInput: a real synthetic keystroke
 *                     that reaches whichever control has focus, exactly like typing.
 *                     This DOES take the foreground window, so it is never implicit.
 */
import { parseHwnd, hwndToString, loadNative } from './native.js';

const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;
const WM_CHAR = 0x0102;
const WM_SYSKEYDOWN = 0x0104;
const WM_SYSKEYUP = 0x0105;
const SW_RESTORE = 9;
const INPUT_KEYBOARD = 1;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;
const KEYEVENTF_EXTENDEDKEY = 0x0001;
const MAPVK_VK_TO_VSC = 0;

const VK = {
  BACKSPACE: 0x08, TAB: 0x09, ENTER: 0x0d, RETURN: 0x0d, SHIFT: 0x10, CTRL: 0x11,
  CONTROL: 0x11, ALT: 0x12, MENU: 0x12, PAUSE: 0x13, CAPSLOCK: 0x14, ESC: 0x1b,
  ESCAPE: 0x1b, SPACE: 0x20, PAGEUP: 0x21, PRIOR: 0x21, PAGEDOWN: 0x22, NEXT: 0x22,
  END: 0x23, HOME: 0x24, LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28,
  PRINTSCREEN: 0x2c, INSERT: 0x2d, DELETE: 0x2e, DEL: 0x2e,
  LWIN: 0x5b, RWIN: 0x5c, APPS: 0x5d,
  NUMPAD0: 0x60, NUMPAD1: 0x61, NUMPAD2: 0x62, NUMPAD3: 0x63, NUMPAD4: 0x64,
  NUMPAD5: 0x65, NUMPAD6: 0x66, NUMPAD7: 0x67, NUMPAD8: 0x68, NUMPAD9: 0x69,
  MULTIPLY: 0x6a, ADD: 0x6b, SUBTRACT: 0x6d, DECIMAL: 0x6e, DIVIDE: 0x6f,
  NUM_LOCK: 0x90, SCROLL_LOCK: 0x91,
  LSHIFT: 0xa0, RSHIFT: 0xa1, LCTRL: 0xa2, RCTRL: 0xa3, LALT: 0xa4, RALT: 0xa5,
};

const EXTENDED = new Set([0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2d, 0x2e, 0x5b, 0x5c, 0x5d, 0x90, 0x6f]);

for (let code = 0x30; code <= 0x39; code++) VK['DIGIT' + String.fromCharCode(code)] = code;
for (let code = 0x41; code <= 0x5a; code++) VK[String.fromCharCode(code)] = code;
for (let n = 1; n <= 12; n++) VK['F' + n] = 0x6f + n;

function resolveToken(token) {
  const cleaned = String(token).trim();
  if (cleaned === '') return null;
  const upper = cleaned.toUpperCase();
  if (Object.hasOwn(VK, upper)) return { vk: VK[upper], label: upper };
  if (upper.startsWith('VK_') && Object.hasOwn(VK, upper.slice(3))) return { vk: VK[upper.slice(3)], label: upper };
  if (cleaned.length === 1) {
    const code = cleaned.toUpperCase().charCodeAt(0);
    return { vk: code, label: cleaned, char: cleaned };
  }
  throw new Error('unknown key token: ' + JSON.stringify(cleaned));
}

function keyEventBuffer(vk, flags, scan, extraInfo) {
  const buffer = Buffer.alloc(40);
  buffer.writeUInt32LE(INPUT_KEYBOARD, 0);
  buffer.writeUInt16LE(vk, 8);
  buffer.writeUInt16LE(scan, 10);
  buffer.writeUInt32LE(flags, 12);
  buffer.writeUInt32LE(0, 16);
  buffer.writeBigUInt64LE(BigInt(extraInfo ?? 0), 24);
  return buffer;
}

function unicodeEventBuffer(codeUnit, flags) {
  const buffer = Buffer.alloc(40);
  buffer.writeUInt32LE(INPUT_KEYBOARD, 0);
  buffer.writeUInt16LE(0, 8);
  buffer.writeUInt16LE(codeUnit, 10);
  buffer.writeUInt32LE(KEYEVENTF_UNICODE | flags, 12);
  return buffer;
}

/**
 * Bring a window to the foreground (explicitly intrusive).
 * @param {string|number} hwndText
 */
export function activateWindow(hwndText) {
  const n = loadNative();
  const hwnd = parseHwnd(hwndText);
  if (!n.IsWindow(hwnd)) throw new Error('no such window: ' + hwndText);
  const started = process.hrtime.bigint();
  const pid = [0];
  n.GetWindowThreadProcessId(hwnd, pid);
  n.AllowSetForegroundWindow(pid[0]);
  if (n.IsIconic(hwnd)) n.ShowWindow(hwnd, SW_RESTORE);
  n.BringWindowToTop(hwnd);
  const setOk = Boolean(n.SetForegroundWindow(hwnd));
  n.SetActiveWindow(hwnd);
  const foreground = hwndToString(n.GetForegroundWindow());
  return {
    hwnd: hwndToString(hwnd),
    foreground,
    isForeground: foreground === hwndToString(hwnd),
    setForegroundWindowReturned: setOk,
    elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
  };
}

function focusTarget(n, hwnd) {
  const pid = [0];
  const thread = n.GetWindowThreadProcessId(hwnd, pid);
  const info = { cbSize: 72, flags: 0, hwndActive: null, hwndFocus: null, hwndCapture: null, hwndMenuOwner: null, hwndMoveSize: null, hwndCaret: null, rcCaret: [0, 0, 0, 0] };
  let focus = null;
  try {
    if (thread && n.GetGUIThreadInfo(thread, info)) focus = info.hwndFocus;
  } catch {
    focus = null;
  }
  return focus && Number(focus) !== 0 ? focus : hwnd;
}

/**
 * Send keystrokes.
 * @param {string|number} hwndText
 * @param {{ keys: string[], mode?: 'post'|'input', submit?: boolean }} options
 */
export function sendKeys(hwndText, options) {
  const n = loadNative();
  const hwnd = parseHwnd(hwndText);
  if (!n.IsWindow(hwnd)) throw new Error('no such window: ' + hwndText);
  const mode = options.mode === 'input' ? 'input' : 'post';
  const started = process.hrtime.bigint();
  const sent = [];
  const skipped = [];
  const tokens = Array.isArray(options.keys) ? options.keys : [];
  if (tokens.length === 0) throw new Error('keys must contain at least one key token');

  if (mode === 'post') {
    const target = focusTarget(n, hwnd);
    for (const token of tokens) {
      const parts = String(token).split('+').map((part) => part.trim()).filter(Boolean);
      const modifiers = parts.slice(0, -1).map(resolveToken);
      const main = resolveToken(parts[parts.length - 1]);
      if (!main) continue;
      const scan = n.MapVirtualKeyW(main.vk, MAPVK_VK_TO_VSC);
      for (const modifier of modifiers) {
        const modifierScan = n.MapVirtualKeyW(modifier.vk, MAPVK_VK_TO_VSC);
        n.PostMessageW(target, WM_KEYDOWN, modifier.vk, (modifierScan << 16) | 1);
      }
      const isExtended = EXTENDED.has(main.vk) ? (1 << 24) : 0;
      n.PostMessageW(target, WM_KEYDOWN, main.vk, (scan << 16) | 1 | isExtended);
      if (main.char && modifiers.length === 0) {
        n.PostMessageW(target, WM_CHAR, main.char.charCodeAt(0), (scan << 16) | 1);
      }
      n.PostMessageW(target, WM_KEYUP, main.vk, ((scan << 16) | 1 | isExtended | 0xc0000000) >>> 0);
      for (const modifier of modifiers.reverse()) {
        const modifierScan = n.MapVirtualKeyW(modifier.vk, MAPVK_VK_TO_VSC);
        n.PostMessageW(target, WM_KEYUP, modifier.vk, ((modifierScan << 16) | 1 | 0xc0000000) >>> 0);
      }
      sent.push((modifiers.length ? modifiers.map((m) => m.label).join('+') + '+' : '') + main.label);
    }
    if (options.submit) {
      const scan = n.MapVirtualKeyW(0x0d, MAPVK_VK_TO_VSC);
      n.PostMessageW(target, WM_KEYDOWN, 0x0d, (scan << 16) | 1);
      n.PostMessageW(target, WM_CHAR, 0x0d, (scan << 16) | 1);
      n.PostMessageW(target, WM_KEYUP, 0x0d, ((scan << 16) | 1 | 0xc0000000) >>> 0);
      sent.push('Enter');
    }
    return { mode, target: hwndToString(target), sent, skipped, elapsedMs: Number(process.hrtime.bigint() - started) / 1e6 };
  }

  // input lane: real synthetic keys, foreground required.
  const activation = activateWindow(hwndText);
  for (const token of tokens) {
    const parts = String(token).split('+').map((part) => part.trim()).filter(Boolean);
    const modifiers = parts.slice(0, -1).map(resolveToken).filter(Boolean);
    const main = resolveToken(parts[parts.length - 1]);
    if (!main) continue;
    const events = [];
    for (const modifier of modifiers) {
      events.push(keyEventBuffer(modifier.vk, 0, 0, 0));
    }
    const scan = n.MapVirtualKeyW(main.vk, MAPVK_VK_TO_VSC);
    events.push(keyEventBuffer(main.vk, EXTENDED.has(main.vk) ? KEYEVENTF_EXTENDEDKEY : 0, scan, 0));
    events.push(keyEventBuffer(main.vk, (EXTENDED.has(main.vk) ? KEYEVENTF_EXTENDEDKEY : 0) | KEYEVENTF_KEYUP, scan, 0));
    for (const modifier of modifiers.slice().reverse()) {
      events.push(keyEventBuffer(modifier.vk, KEYEVENTF_KEYUP, 0, 0));
    }
    const payload = Buffer.concat(events);
    const delivered = n.SendInput(events.length, payload, 40);
    if (delivered !== events.length) skipped.push(token + ' (SendInput delivered ' + delivered + '/' + events.length + ')');
    else sent.push((modifiers.length ? modifiers.map((m) => m.label).join('+') + '+' : '') + main.label);
  }
  if (options.submit) {
    const scan = n.MapVirtualKeyW(0x0d, MAPVK_VK_TO_VSC);
    const payload = Buffer.concat([keyEventBuffer(0x0d, 0, scan, 0), keyEventBuffer(0x0d, KEYEVENTF_KEYUP, scan, 0)]);
    n.SendInput(2, payload, 40);
    sent.push('Enter');
  }
  return { mode, target: hwndToString(hwnd), sent, skipped, activation, elapsedMs: Number(process.hrtime.bigint() - started) / 1e6 };
}
