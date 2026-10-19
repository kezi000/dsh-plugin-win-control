/**
 * hot-reload.mjs - reload the plugin into the running DSH without restarting it.
 *
 * lib/*.js is cached by the ESM loader, but cordis.patch.yml reloads live and a
 * module URL with a query string is a different module instance. So: drop the
 * entry, wait, then re-add it with a fresh ?v= cache-buster.
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PATCH = join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
const ENTRY = 'file:///C:/Users/86551/.dsh/plugins/dsh-plugin-win-control/lib/index.js';
const MARKER = '# Windows desktop + Chromium control';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const text = readFileSync(PATCH, 'utf8');
const start = text.indexOf(MARKER);
if (start < 0) {
  console.error('entry not found in ' + PATCH);
  process.exit(1);
}
copyFileSync(PATCH, PATCH + '.bak-hotreload-' + Date.now());
writeFileSync(PATCH, text.slice(0, start), 'utf8');
console.log('entry removed - waiting for the loader to dispose it...');
await sleep(3000);

const block = [
  '',
  MARKER + ' (dsh-plugin-win-control 0.2.2).',
  '# 20 tools: win_* (Win32/UIA/capture) + cdp_* (isolated Chromium over CDP).',
  '# Default paths never move the cursor, steal focus or raise a window;',
  '# win_activate and win_send_keys{mode:input} are the two explicitly intrusive lanes.',
  '# The ?v= query is a cache-buster: bump it after editing lib/*.js (see README).',
  '- insert:',
  '    - id: win-control',
  "      name: '" + ENTRY + '?v=' + Date.now() + "'",
  '      config:',
  '        captureKeep: 200',
  '        uiaMaxNodes: 400',
  '        cdpPort: 9222',
  '        cdpTimeoutMs: 10000',
  '',
].join('\n');
writeFileSync(PATCH, readFileSync(PATCH, 'utf8') + block, 'utf8');
console.log('entry re-added with a fresh cache-buster - waiting for apply()...');
await sleep(4000);
console.log('done: win_* / cdp_* should be live again (verify with node test\\contracts.mjs)');