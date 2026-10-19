/**
 * e2e-winforms.mjs - proves the recommended path on a legacy WinForms window:
 * UIA tree -> WM_CHAR typing into the edit box -> posted click on the button
 * -> the label text changes. Exits non-zero when any step fails.
 *
 * The window is created by test-target.ps1 and closed at the end.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { listWindows } from '../lib/native.js';
import { createUiaWorker } from '../lib/uia.js';
import { clickWindow, typeIntoWindow } from '../lib/input.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const POWERSHELL = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const target = spawn(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, '..', 'test-target.ps1')], { stdio: 'ignore', windowsHide: false, cwd: tmpdir() });
await new Promise((r) => setTimeout(r, 2200));

let failures = 0;
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail ? ' - ' + detail : ''));
  if (!ok) failures++;
};

try {
  const { windows } = listWindows({ titleOnly: true });
  const win = windows.find((x) => x.title.includes('WinControl UIA Test Target'));
  if (!win) throw new Error('test window not found');
  const hwnd = Number(BigInt(win.hwnd));
  const worker = createUiaWorker();
  await worker.start();

  const tree = await worker.request('tree', { hwnd, maxDepth: 4, maxNodes: 20 });
  const nodes = tree.nodes || [];
  const go = nodes.find((n) => n.name === 'Go');
  const box = nodes.find((n) => n.controlType === 'Pane' && n.name === '' && n.rect && n.rect.width > 100);
  check('uia tree exposes the Go button', Boolean(go), JSON.stringify(go && go.rect));
  check('uia tree exposes the edit box', Boolean(box));

  const typed = typeIntoWindow(win.hwnd, {
    text: 'typed-by-post',
    at: { x: box.rect.x + 20, y: box.rect.y + Math.round(box.rect.height / 2) },
  });
  check('wm_char typing posted', typed.characters === 13, JSON.stringify({ chars: typed.characters, target: typed.targetHwnd }));

  await new Promise((r) => setTimeout(r, 150));
  const clicked = clickWindow(win.hwnd, { x: go.rect.x + go.rect.width / 2, y: go.rect.y + go.rect.height / 2 });
  check('posted click reached a child window', clicked.depth >= 1, JSON.stringify({ target: clicked.targetHwnd, depth: clicked.depth }));

  await new Promise((r) => setTimeout(r, 300));
  const after = await worker.request('tree', { hwnd, maxDepth: 4, maxNodes: 20 });
  const names = (after.nodes || []).map((n) => n.name);
  check('button handler ran with the typed text', names.includes('clicked:typed-by-post'), JSON.stringify(names));
  worker.close();
} catch (error) {
  console.log('FAIL ' + (error && error.message));
  failures++;
} finally {
  target.kill();
}

console.log(failures === 0 ? 'e2e: all checks passed' : 'e2e: ' + failures + ' check(s) failed');
process.exit(failures === 0 ? 0 : 1);