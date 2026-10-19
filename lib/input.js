/**
 * input.js - background (message-based) clicking and typing.
 *
 * Posts window messages instead of injecting synthetic input: the physical cursor
 * does not move, no window is brought to the foreground, and the user keeps the
 * keyboard. Applications that ignore posted messages (DirectInput games, some
 * custom-drawn UIs) will not react - that limitation is deliberate.
 */
import { parseHwnd, hwndToString, loadNative } from './native.js';

const WM_MOUSEMOVE = 0x0200;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const MK_LBUTTON = 0x0001;
const WM_CHAR = 0x0102;
const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;
const CWP_SKIPINVISIBLE = 0x0001;

function makeLParam(x, y) {
  return (Math.round(y) << 16) | (Math.round(x) & 0xffff);
}

function clientOrigin(n, hwnd) {
  const pt = [0, 0];
  n.ClientToScreen(hwnd, pt);
  return { x: pt[0], y: pt[1] };
}

/**
 * Click inside a window by posting mouse messages down the child-window chain.
 *
 * @param {string|number} hwndText
 * @param {{ x: number, y: number, space?: 'client'|'screen' }} options
 *        space defaults to screen (the space used by UI Automation rectangles).
 */
function resolveDeepest(n, hwnd, options) {
  const space = options.space === 'client' ? 'client' : 'screen';
  let pt;
  if (space === 'screen') {
    const origin = clientOrigin(n, hwnd);
    pt = { x: Math.round(options.x) - origin.x, y: Math.round(options.y) - origin.y };
  } else {
    pt = { x: Math.round(options.x), y: Math.round(options.y) };
  }
  let current = hwnd;
  let currentOrigin = clientOrigin(n, hwnd);
  let depth = 0;
  for (; depth < 8; depth++) {
    const child = n.ChildWindowFromPointEx(current, { x: pt.x, y: pt.y }, CWP_SKIPINVISIBLE);
    if (!child || Number(child) === 0 || hwndToString(child) === hwndToString(current)) break;
    const screenX = currentOrigin.x + pt.x;
    const screenY = currentOrigin.y + pt.y;
    current = child;
    currentOrigin = clientOrigin(n, child);
    pt = { x: screenX - currentOrigin.x, y: screenY - currentOrigin.y };
  }
  return { hwnd: current, depth, pt, origin: currentOrigin };
}

export function clickWindow(hwndText, options) {
  const n = loadNative();
  const hwnd = parseHwnd(hwndText);
  if (!n.IsWindow(hwnd)) throw new Error('no such window: ' + hwndText);
  const started = process.hrtime.bigint();
  const resolved = resolveDeepest(n, hwnd, options);
  const current = resolved.hwnd;
  const pt = resolved.pt;
  const depth = resolved.depth;
  const lParam = makeLParam(pt.x, pt.y);
  n.PostMessageW(current, WM_MOUSEMOVE, 0, lParam);
  n.PostMessageW(current, WM_LBUTTONDOWN, MK_LBUTTON, lParam);
  n.PostMessageW(current, WM_LBUTTONUP, 0, lParam);
  return { targetHwnd: hwndToString(current), depth, clientX: pt.x, clientY: pt.y, elapsedMs: Number(process.hrtime.bigint() - started) / 1e6 };
}

/**
 * Type text with WM_CHAR messages; no focus change, no global keystrokes.
 *
 * @param {string|number} hwndText
 * @param {{ text: string, submit?: boolean, targetHwnd?: string }} options
 */
export function typeIntoWindow(hwndText, options) {
  const n = loadNative();
  const hwnd = parseHwnd(hwndText);
  if (!n.IsWindow(hwnd)) throw new Error('no such window: ' + hwndText);
  let target = hwnd;
  if (options.targetHwnd) target = parseHwnd(options.targetHwnd);
  else if (options.at) target = resolveDeepest(n, hwnd, { x: options.at.x, y: options.at.y, space: options.at.space }).hwnd;
  const started = process.hrtime.bigint();
  let characters = 0;
  const skipped = [];
  for (const ch of options.text) {
    const code = ch.codePointAt(0);
    if (code > 0xffff) { skipped.push('U+' + code.toString(16).toUpperCase()); continue; }
    n.PostMessageW(target, WM_CHAR, code, 1);
    characters++;
  }
  if (options.submit) {
    n.PostMessageW(target, WM_KEYDOWN, 0x0d, 1);
    n.PostMessageW(target, WM_CHAR, 0x0d, 1);
    n.PostMessageW(target, WM_KEYUP, 0x0d, 0xc0000001);
    characters++;
  }
  return { targetHwnd: hwndToString(target), characters, skipped, elapsedMs: Number(process.hrtime.bigint() - started) / 1e6 };
}
