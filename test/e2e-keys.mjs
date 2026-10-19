/**
 * e2e-keys.mjs - window activation and both keystroke lanes.
 *
 * post  lane: WM_KEY* delivered to the focus control, foreground untouched.
 * input lane: real SendInput after an explicit activation.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { listWindows } from '../lib/native.js';
import { createUiaWorker } from '../lib/uia.js';
import { clickWindow } from '../lib/input.js';
import { activateWindow, sendKeys } from '../lib/keys.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const target = spawn('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, '..', 'test-target.ps1')],
  { stdio: 'ignore', windowsHide: false, cwd: tmpdir() });
await new Promise((r) => setTimeout(r, 2400));

let failures = 0;
const check = (label, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail ? ' - ' + detail : '')); if (!ok) failures++; };

try {
  const { windows } = listWindows({ titleOnly: true });
  const win = windows.find((x) => x.title.includes('WinControl UIA Test Target'));
  if (!win) throw new Error('test window not found');
  const hwnd = Number(BigInt(win.hwnd));
  const worker = createUiaWorker();
  await worker.start();
  const label = async () => {
    const reply = await worker.request('tree', { hwnd, maxDepth: 3, maxNodes: 10 });
    const node = (reply.nodes || []).find((n) => /^(idle|clicked:|key:)/.test(n.name));
    return node ? node.name : '';
  };

  const before = await label();
  check('target starts idle', before === 'idle', JSON.stringify(before));

  const activation = activateWindow(win.hwnd);
  check('window reached the foreground', activation.isForeground, JSON.stringify({ fg: activation.foreground, ok: activation.setForegroundWindowReturned }));

  const posted = sendKeys(win.hwnd, { keys: ['F5'] });
  await new Promise((r) => setTimeout(r, 250));
  const afterPost = await label();
  check('post lane delivered F5', afterPost === 'key:F5', JSON.stringify({ sent: posted.sent, label: afterPost }));

  const posted2 = sendKeys(win.hwnd, { keys: ['ESCAPE'] });
  await new Promise((r) => setTimeout(r, 200));
  const afterEsc = await label();
  check('post lane delivered Escape', afterEsc === 'key:Escape', JSON.stringify({ sent: posted2.sent, label: afterEsc }));

  const real = sendKeys(win.hwnd, { keys: ['F6'], mode: 'input' });
  await new Promise((r) => setTimeout(r, 300));
  const afterInput = await label();
  check('input lane delivered F6 via SendInput', afterInput === 'key:F6', JSON.stringify({ sent: real.sent, skipped: real.skipped, label: afterInput }));

  const tree = await worker.request('tree', { hwnd, maxDepth: 3, maxNodes: 10 });
  const box = (tree.nodes || []).find((n) => n.controlType === 'Pane' && n.name === '' && n.rect && n.rect.width > 100);
  if (box) {
    clickWindow(win.hwnd, { x: box.rect.x + 20, y: box.rect.y + Math.round(box.rect.height / 2) });
    await new Promise((r) => setTimeout(r, 120));
    const typed = sendKeys(win.hwnd, { keys: ['H', 'I'] });
    await new Promise((r) => setTimeout(r, 250));
    const names = ((await worker.request('tree', { hwnd, maxDepth: 3, maxNodes: 10 })).nodes || []).map((n) => n.name);
    check('post lane: characters landed in the focused edit box', names.some((n) => /^hi$/i.test(n)), JSON.stringify({ sent: typed.sent, names }));
    const enter = sendKeys(win.hwnd, { keys: ['ENTER'] });
    await new Promise((r) => setTimeout(r, 250));
    const afterEnter = await label();
    check('post lane: Enter raised a key event', afterEnter === 'key:Return', JSON.stringify({ sent: enter.sent, label: afterEnter }));
  } else {
    console.log('SKIP focus lane (edit box not found)');
  }
  worker.close();
} catch (error) {
  console.log('FAIL ' + (error && error.message));
  failures++;
} finally {
  target.kill();
}

console.log(failures === 0 ? 'keys e2e: all checks passed' : 'keys e2e: ' + failures + ' failed');
process.exit(failures === 0 ? 0 : 1);