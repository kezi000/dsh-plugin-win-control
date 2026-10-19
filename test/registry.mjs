import { apply } from '../lib/index.js';
const defs = new Map();
const skills = [];
const ctx = {
  tools: { register(d) { defs.set(d.name, d); } },
  get(name) { if (name === 'skills') return { register(s) { skills.push(s); } }; return undefined; },
  effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
  logger: { info() {}, warn: (...a) => console.warn('[warn]', ...a) },
};
apply(ctx, {});
console.log('tool count:', defs.size);
console.log([...defs.keys()].join(', '));
console.log('skills:', skills.map((s) => s.name).join(','));
process.exit(0);