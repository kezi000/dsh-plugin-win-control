/**
 * e2e-cdp-tools.mjs - drives the model-facing cdp_* tools end to end:
 * launch -> targets -> snapshot -> type -> click -> eval -> screenshot -> close.
 */
import { apply } from '../lib/index.js';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

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
let failures = 0;
const check = (label, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail ? ' - ' + detail : '')); if (!ok) failures++; };
const call = async (name, args) => {
  const def = defs.get(name);
  const t = Date.now();
  const value = await def.execute(args, exec);
  return { ms: Date.now() - t, value, blocks: def.output.render(args, value) };
};

let port = 0;
try {
  const pageUrl = 'file:///' + join(HERE, 'page.html').replace(/\\/g, '/');
  const launched = await call('cdp_launch', { url: pageUrl, headless: true });
  port = launched.value.port;
  console.log(launched.blocks[0].text);
  check('cdp_launch returned a port', port > 0);

  const targets = await call('cdp_targets', { port });
  check('cdp_targets sees the page', targets.value.count >= 1, JSON.stringify(targets.value.targets.map((t) => t.url.slice(0, 40))));

  const snap = await call('cdp_snapshot', { port, max_nodes: 60 });
  check('cdp_snapshot found interactive elements', snap.value.interactive.length >= 2, snap.value.interactive.map((r) => r.tag).join(',') + ' / ' + snap.ms + 'ms');
  const button = snap.value.interactive.find((r) => r.tag === 'button');
  const input = snap.value.interactive.find((r) => r.tag === 'input');

  const typed = await call('cdp_type', { port, selector: input.ref, text: 'via-tools' });
  check('cdp_type wrote the value', typed.value.ok && typed.value.value === 'via-tools', JSON.stringify(typed.value));

  const clicked = await call('cdp_click', { port, selector: button.ref });
  check('cdp_click dispatched', clicked.value.ok === true, clicked.blocks[0].text);

  const evaled = await call('cdp_eval', { port, expression: 'document.getElementById("out").textContent' });
  check('cdp_eval read the updated text', evaled.value.value_json.includes('hello via-tools'), evaled.value.value_json);

  const shot = await call('cdp_screenshot', { port });
  check('cdp_screenshot produced a png', shot.value.ok && shot.value.bytes > 1000, shot.blocks[0].text.split('\n')[0]);

  const closed = await call('cdp_close', { port });
  check('cdp_close killed the browser', closed.value.ok === true);
} catch (error) {
  console.log('ERROR ' + (error && error.stack ? error.stack : error));
  failures++;
}

console.log(failures === 0 ? 'cdp tools e2e: all checks passed' : 'cdp tools e2e: ' + failures + ' failed');
process.exit(failures === 0 ? 0 : 1);