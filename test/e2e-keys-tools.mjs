/**
 * e2e-keys-tools.mjs - drives win_activate / win_send_keys through the tool layer
 * against a real WinForms window, then reads the result back with win_uia_tree.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { apply } from '../lib/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const defs = new Map();
const ctx = {
  tools: { register(d) { defs.set(d.name, d); } },
  get() { return undefined; },
  effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
  logger: { info() {}, warn: (...a) => console.warn('[warn]', ...a) },
};
apply(ctx, {});
const exec = { signal: new AbortController().signal };
const call = async (name, args) => defs.get(name).execute(args, exec);

const target = spawn('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, '..', 'test-target.ps1')],
  { stdio: 'ignore', windowsHide: false, cwd: tmpdir() });
await new Promise((r) => setTimeout(r, 2400));

let failures = 0;
const check = (label, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail ? ' - ' + detail : '')); if (!ok) failures++; };

try {
  const list = await call('win_list_windows', { query: 'WinControl UIA Test Target' });
  const win = list.windows[0];
  check('win_list_windows found the target', Boolean(win), win && win.hwnd);
  const hwnd = win.hwnd;

  const activation = await call('win_activate', { hwnd });
  check('win_activate raised the window', activation.is_foreground === true, JSON.stringify(activation));

  const posted = await call('win_send_keys', { hwnd, keys: ['F7'] });
  await new Promise((r) => setTimeout(r, 250));
  let tree = await call('win_uia_tree', { hwnd, max_depth: 3, max_nodes: 10 });
  let names = tree.nodes.map((n) => n.name);
  check('post lane F7 reached the window', names.includes('key:F7'), JSON.stringify({ sent: posted.sent, names }));

  const real = await call('win_send_keys', { hwnd, keys: ['F8'], mode: 'input' });
  await new Promise((r) => setTimeout(r, 300));
  tree = await call('win_uia_tree', { hwnd, max_depth: 3, max_nodes: 10 });
  names = tree.nodes.map((n) => n.name);
  check('input lane F8 reached the window', names.includes('key:F8'), JSON.stringify({ sent: real.sent, skipped: real.skipped, names }));

  const combo = await call('win_send_keys', { hwnd, keys: ['CTRL+A'] });
  check('combo token accepted', combo.sent.includes('CTRL+A'), JSON.stringify(combo.sent));
} catch (error) {
  console.log('ERROR ' + (error && error.stack ? error.stack : error));
  failures++;
} finally {
  target.kill();
}

console.log(failures === 0 ? 'keys tools e2e: all checks passed' : 'keys tools e2e: ' + failures + ' failed');
process.exit(failures === 0 ? 0 : 1);