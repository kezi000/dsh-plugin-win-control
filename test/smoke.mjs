import { apply } from '../lib/index.js';
const defs = new Map();
const ctx = {
  tools: { register(def) { defs.set(def.name, def); } },
  get() { return undefined; },
  effect(fn, label) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose(); }; },
  logger: { warn: (...a) => console.warn('[warn]', ...a) },
};
apply(ctx, {});
console.log('registered:', [...defs.keys()].join(', '));
const exec = { signal: new AbortController().signal };
const call = async (n, args) => {
  const def = defs.get(n);
  const t = Date.now();
  const value = await def.execute(args, exec);
  const blocks = def.output.render(args, value);
  return { ms: Date.now() - t, value, blocks };
};
const list = await call('win_list_windows', { limit: 5 });
console.log('win_list_windows', list.ms + 'ms ->', list.blocks[0].text.split('\n').slice(0, 8).join(' | '));
const fg = list.value.windows.find((w) => w.foreground) || list.value.windows[0];
console.log('picked', fg.hwnd, JSON.stringify(fg.title.slice(0, 40)));
const info = await call('win_window_info', { hwnd: fg.hwnd });
console.log('win_window_info ->', info.blocks[0].text.replace(/\n/g, ' | '));
const tree = await call('win_uia_tree', { hwnd: fg.hwnd, max_depth: 5, max_nodes: 40 });
console.log('win_uia_tree', tree.ms + 'ms ok=' + tree.value.ok, 'nodes=' + tree.value.count);
console.log(tree.blocks[0].text.split('\n').slice(0, 10).join('\n'));
const cap = await call('win_capture', { hwnd: fg.hwnd });
console.log('win_capture', cap.ms + 'ms', cap.value.width + 'x' + cap.value.height, cap.value.bytes + 'B', 'saved=' + cap.value.saved_path, 'blocks=' + cap.blocks.length);
const scr = await call('win_screen_info', {});
console.log('win_screen_info ->', scr.blocks[0].text);
process.exit(0);