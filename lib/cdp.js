/**
 * cdp.js - Chrome DevTools Protocol client for Electron / Chromium targets.
 *
 * This is the precise half of the plugin: a page-level accessibility/DOM snapshot
 * (~5-20 ms) and element-level click/type that never touches the OS input queue,
 * so it cannot collide with whatever the user is doing in another window.
 *
 * Transport is a plain WebSocket JSON-RPC channel; no browser automation
 * framework is involved.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');

const OBJID_CLIENT = 0;

/** Fetch JSON from the DevTools HTTP endpoint. */
async function httpJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error('HTTP ' + response.status + ' from ' + url);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** List page targets exposed on a loopback debugging port. */
export async function listTargets(port, timeoutMs = 4000) {
  const rows = await httpJson('http://127.0.0.1:' + port + '/json/list', timeoutMs);
  return rows
    .filter((t) => t.type === 'page' || t.type === 'webview')
    .map((t) => ({
      id: t.id,
      type: t.type,
      title: t.title,
      url: t.url,
      wsUrl: t.webSocketDebuggerUrl,
    }));
}

/** One CDP connection. Requests are matched by id; events are ignored. */
export function createCdpClient(wsUrl, options = {}) {
  const timeoutMs = options.timeoutMs ?? 8000;
  const socket = new WebSocket(wsUrl, { perMessageDeflate: false, handshakeTimeout: timeoutMs });
  const pending = new Map();
  let nextId = 1;
  let opened = false;
  let closedError = null;

  const ready = new Promise((resolve, reject) => {
    socket.on('open', () => {
      opened = true;
      resolve();
    });
    socket.on('error', (error) => {
      if (!opened) reject(error);
      closedError = error;
    });
    socket.on('close', () => {
      closedError = closedError ?? new Error('CDP socket closed');
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(closedError);
      }
      pending.clear();
    });
  });

  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message + (message.error.data ? ' (' + message.error.data + ')' : '')));
    else entry.resolve(message.result);
  });

  function send(method, params = {}, callTimeoutMs = timeoutMs) {
    return ready.then(() => new Promise((resolve, reject) => {
      if (closedError) {
        reject(closedError);
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('CDP ' + method + ' timed out after ' + callTimeoutMs + ' ms'));
      }, callTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    }));
  }

  return {
    send,
    close() {
      try { socket.close(); } catch {}
    },
    /** Evaluate an expression in the page and return its by-value result. */
    async evaluate(expression, callTimeoutMs) {
      const result = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      }, callTimeoutMs);
      if (result.exceptionDetails) {
        const detail = result.exceptionDetails.exception && result.exceptionDetails.exception.description;
        throw new Error('page exception: ' + (detail || result.exceptionDetails.text));
      }
      return result.result ? result.result.value : undefined;
    },
  };
}

/* ---------------------------------------------------------------- page code */
/* These functions are serialized with .toString() and evaluated inside the page,
   so they must not reference anything from this module's scope.               */

function snapshotInPage(maxNodes) {
  const cssPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 12) {
      let part = node.tagName.toLowerCase();
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
        parts.unshift(part + '#' + node.id);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const index = Array.prototype.indexOf.call(parent.children, node) + 1;
        part += ':nth-child(' + index + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return null;
    return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
  };
  const text = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const rows = [];
  const seen = new Set();
  const selector = 'a,button,input,select,textarea,summary,[role],[tabindex],[onclick],[contenteditable="true"],[contenteditable=""]';
  for (const el of document.querySelectorAll(selector)) {
    if (seen.has(el)) continue;
    seen.add(el);
    const box = visible(el);
    if (!box) continue;
    rows.push({
      ref: cssPath(el),
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      type: el.getAttribute('type') || '',
      name: el.getAttribute('name') || '',
      text: text(el).slice(0, 80),
      value: typeof el.value === 'string' ? el.value.slice(0, 80) : '',
      placeholder: el.getAttribute('placeholder') || '',
      disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
      box,
    });
    if (rows.length >= maxNodes) break;
  }
  const textNodes = [];
  for (const el of document.querySelectorAll('h1,h2,h3,h4,h5,label,li,td,th,p,span,div')) {
    if (el.children.length !== 0) continue;
    const value = text(el);
    if (value.length < 2) continue;
    const box = visible(el);
    if (!box) continue;
    textNodes.push({ ref: cssPath(el), tag: el.tagName.toLowerCase(), text: value, box });
    if (rows.length + textNodes.length >= maxNodes) break;
  }
  return {
    title: document.title,
    url: location.href,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    interactive: rows,
    text: textNodes,
    truncated: rows.length + textNodes.length >= maxNodes,
  };
}

function clickInPage(selector) {
  const el = document.querySelector(selector);
  if (!el) return { ok: false, reason: 'selector not found: ' + selector };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.focus({ preventScroll: true });
  const rect = el.getBoundingClientRect();
  const init = { bubbles: true, cancelable: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2, view: window };
  el.dispatchEvent(new PointerEvent('pointerdown', init));
  el.dispatchEvent(new MouseEvent('mousedown', init));
  el.dispatchEvent(new PointerEvent('pointerup', init));
  el.dispatchEvent(new MouseEvent('mouseup', init));
  el.dispatchEvent(new MouseEvent('click', init));
  return { ok: true, tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').slice(0, 60) };
}

function typeInPage(selector, value, submit) {
  const el = document.querySelector(selector);
  if (!el) return { ok: false, reason: 'selector not found: ' + selector };
  el.scrollIntoView({ block: 'center' });
  el.focus({ preventScroll: true });
  const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (setter && setter.set) setter.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  if (submit) {
    const key = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
    el.dispatchEvent(new KeyboardEvent('keydown', key));
    el.dispatchEvent(new KeyboardEvent('keypress', key));
    el.dispatchEvent(new KeyboardEvent('keyup', key));
    if (typeof el.form !== 'undefined' && el.form && typeof el.form.requestSubmit === 'function') {
      el.form.requestSubmit();
    }
  }
  return { ok: true, value: typeof el.value === 'string' ? el.value.slice(0, 80) : '' };
}

function clickTextInPage(text) {
  const wanted = text.trim();
  const candidates = document.querySelectorAll('a,button,[role=button],[role=link],[role=tab],[role=menuitem],summary,label');
  for (const el of candidates) {
    const label = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (label === wanted || (wanted.length > 2 && label.includes(wanted))) {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus({ preventScroll: true });
      el.click();
      return { ok: true, tag: el.tagName.toLowerCase(), text: label.slice(0, 60) };
    }
  }
  return { ok: false, reason: 'no clickable element with text ' + JSON.stringify(wanted) };
}

export async function clickPageByText(client, text) {
  return client.evaluate('(' + clickTextInPage.toString() + ')(' + JSON.stringify(text) + ')');
}

export async function snapshotPage(client, maxNodes = 120) {
  const expression = '(' + snapshotInPage.toString() + ')(' + Number(maxNodes) + ')';
  return client.evaluate(expression);
}

export async function clickPage(client, selector) {
  return client.evaluate('(' + clickInPage.toString() + ')(' + JSON.stringify(selector) + ')');
}

export async function typePage(client, selector, value, submit) {
  return client.evaluate('(' + typeInPage.toString() + ')(' + JSON.stringify(selector) + ',' + JSON.stringify(value) + ',' + Boolean(submit) + ')');
}

/* ------------------------------------------------------------- browser launch */

const launched = new Map();

function waitForDevToolsPort(userDataDir, timeoutMs) {
  const file = join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (existsSync(file)) {
        const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
        const port = Number(lines[0]);
        if (Number.isInteger(port) && port > 0) {
          resolve(port);
          return;
        }
      }
      if (Date.now() > deadline) {
        reject(new Error('browser did not expose a debugging port within ' + timeoutMs + ' ms'));
        return;
      }
      setTimeout(poll, 120);
    };
    poll();
  });
}

/**
 * Launch an isolated Chromium browser with a debugging port.
 *
 * A throwaway user-data-dir keeps this instance completely separate from the
 * user's own browser: no shared profile, no shared window, no focus change.
 */
export async function launchBrowser(options) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'dsh-win-cdp-'));
  const args = [
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    '--user-data-dir=' + userDataDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--window-size=' + (options.width ?? 1280) + ',' + (options.height ?? 900),
  ];
  if (options.headless) args.push('--headless=new', '--disable-gpu');
  if (options.url) args.push(options.url);
  const child = spawn(options.browserPath, args, { stdio: 'ignore', windowsHide: false, detached: false });
  const port = await waitForDevToolsPort(userDataDir, options.timeoutMs ?? 20000);
  launched.set(port, { child, userDataDir });
  return { port, pid: child.pid, userDataDir };
}

/**
 * Wait until the document under `client` is loaded *and* is the expected page.
 *
 * Checking readyState alone is not enough: right after a launch the session can
 * still evaluate inside the previous about:blank document, which is already
 * complete. The URL fragment guards against returning that one.
 *
 * @param {object} client - connected CDP client.
 * @param {number} timeoutMs - deadline for the whole wait.
 * @param {string} [expectedUrlFragment] - substring location.href must contain.
 * @returns {{ readyState: string, url: string, title: string }}
 */
export async function waitForDocumentReady(client, timeoutMs = 10000, expectedUrlFragment = '') {
  const deadline = Date.now() + timeoutMs;
  let last = { readyState: 'unknown', url: '', title: '' };
  while (Date.now() < deadline) {
    try {
      const probe = await client.evaluate(
        '({ ready: document.readyState, href: location.href, title: document.title })',
      );
      if (probe && typeof probe === 'object') {
        last = { readyState: String(probe.ready ?? 'unknown'), url: String(probe.href ?? ''), title: String(probe.title ?? '') };
      }
      const onExpectedPage = expectedUrlFragment === '' || last.url.includes(expectedUrlFragment);
      if (last.readyState === 'complete' && onExpectedPage) return last;
    } catch {
      // The execution context is replaced while the navigation commits; retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return last;
}

export function closeBrowser(port) {
  const entry = launched.get(port);
  if (!entry) return false;
  launched.delete(port);
  try { entry.child.kill(); } catch {}
  try { rmSync(entry.userDataDir, { recursive: true, force: true }); } catch {}
  return true;
}

export function launchedPorts() {
  return [...launched.keys()];
}

/** First Chromium-family executable found in the usual install locations. */
export function defaultBrowserPath() {
  const roots = [
    process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA,
  ].filter(Boolean);
  const candidates = [];
  for (const root of roots) {
    candidates.push(join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    candidates.push(join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    candidates.push(join(root, 'Chromium', 'Application', 'chrome.exe'));
  }
  // The host may run with a minimal environment; also probe the fixed locations.
  const systemDrive = process.env.SystemDrive || 'C:';
  candidates.push(systemDrive + '\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  candidates.push(systemDrive + '\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe');
  candidates.push(systemDrive + '\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
  candidates.push(systemDrive + '\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe');
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
