/**
 * contracts.mjs - output contract check: every tool result must be lossless JSON.
 *
 * The harness rejects a tool value that still contains `undefined` (or any value
 * that JSON cannot round-trip), so this test calls each tool once and validates.
 */
import { apply } from '../lib/index.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const defs = new Map();
const ctx = { tools: { register(d) { defs.set(d.name, d); } }, get() { return undefined; }, effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d(); }; }, logger: { info() {}, warn() {} } };
apply(ctx, {});
const exec = { signal: new AbortController().signal };

let failures = 0;
const checkJson = (name, value) => {
  const problems = [];
  const walk = (v, path) => {
    if (v === undefined) problems.push(path + ' = undefined');
    else if (typeof v === 'number' && !Number.isFinite(v)) problems.push(path + ' = ' + v);
    else if (typeof v === 'string') {
      for (let i = 0; i < v.length; i++) {
        const c = v.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
          const next = v.charCodeAt(i + 1);
          if (!(next >= 0xdc00 && next <= 0xdfff)) problems.push(path + ' lone surrogate @' + i);
          else i++;
        } else if (c >= 0xdc00 && c <= 0xdfff) problems.push(path + ' lone surrogate @' + i);
      }
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, path + '[' + i + ']'));
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], path + '.' + k);
  };
  walk(value, name);
  let roundtrip = true;
  try { roundtrip = JSON.stringify(JSON.parse(JSON.stringify(value))) === JSON.stringify(value); } catch { roundtrip = false; }
  if (!roundtrip) problems.push('JSON roundtrip unstable');
  if (problems.length) {
    failures++;
    console.log('FAIL ' + name + ' -> ' + problems.slice(0, 3).join('; '));
  } else {
    console.log('PASS ' + name);
  }
};

const call = async (name, args) => {
  const value = await defs.get(name).execute(args, exec);
  checkJson(name, value);
  return value;
};

// desktop tools against the current foreground window
const list = await call('win_list_windows', { limit: 5 });
const win = list.windows[0];
await call('win_window_info', { hwnd: win.hwnd });
await call('win_screen_info', {});
await call('win_uia_tree', { hwnd: win.hwnd, max_depth: 3, max_nodes: 15 });
await call('win_uia_find', { hwnd: win.hwnd, control_type: 'Button', limit: 3 });
await call('win_capture', { hwnd: win.hwnd, save: false });
await call('win_uia_invoke', { hwnd: win.hwnd, name: '__definitely_not_here__' });

// cdp tools against a local page
const pageUrl = 'file:///' + join(HERE, 'page.html').replace(/\\/g, '/');
const launched = await call('cdp_launch', { url: pageUrl, headless: true });
await call('cdp_targets', { port: launched.port });
const snap = await call('cdp_snapshot', { port: launched.port });
await call('cdp_click', { port: launched.port, selector: snap.interactive[0].ref });
await call('cdp_eval', { port: launched.port, expression: '1+1' });
await call('cdp_screenshot', { port: launched.port, save: false });
await call('cdp_click', { port: launched.port, selector: '#does-not-exist' });
await call('cdp_close', { port: launched.port });

console.log(failures === 0 ? 'contracts: all outputs are lossless JSON' : 'contracts: ' + failures + ' tool(s) violated the contract');
process.exit(failures === 0 ? 0 : 1);