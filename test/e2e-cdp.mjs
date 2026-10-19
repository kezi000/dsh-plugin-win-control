import { launchBrowser, listTargets, createCdpClient, snapshotPage, clickPage, typePage, closeBrowser, waitForDocumentReady } from '../lib/cdp.js';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const pageUrl = 'file:///' + join(HERE, 'page.html').replace(/\\/g, '/');
const launch = await launchBrowser({ browserPath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, url: pageUrl });
console.log('launched on port', launch.port, 'pid', launch.pid);

let failures = 0;
const check = (label, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail ? ' - ' + detail : '')); if (!ok) failures++; };

const targets = await listTargets(launch.port);
const page = targets.find((t) => t.url.includes('page.html')) ?? targets[0];
console.log('targets:', targets.map((t) => t.title + ' <' + t.url.slice(0, 50) + '>').join(' | '));
check('page target discovered', Boolean(page && page.wsUrl));

const client = createCdpClient(page.wsUrl);
// The initial about:blank document is already 'complete', so wait for page.html itself.
const ready = await waitForDocumentReady(client, 10000, 'page.html');
check('page navigated to the fixture', ready, JSON.stringify(ready));
const t0 = Date.now();
const snap = await snapshotPage(client, 60);
console.log('snapshot in', Date.now() - t0, 'ms ->', JSON.stringify({ title: snap.title, interactive: snap.interactive.length, text: snap.text.length }));
for (const row of snap.interactive) console.log('   ', row.tag, JSON.stringify(row.text), row.ref);
const button = snap.interactive.find((r) => r.tag === 'button');
const input = snap.interactive.find((r) => r.tag === 'input');
check('snapshot found the button', Boolean(button));
check('snapshot found the input', Boolean(input));

const t1 = Date.now();
const typed = await typePage(client, input.ref, 'cdp-world', false);
console.log('type in', Date.now() - t1, 'ms ->', JSON.stringify(typed));
const t2 = Date.now();
const clicked = await clickPage(client, button.ref);
console.log('click in', Date.now() - t2, 'ms ->', JSON.stringify(clicked));

const out = await client.evaluate('document.getElementById("out").textContent');
check('page reacted to the synthetic interaction', out === 'hello cdp-world', JSON.stringify(out));

const t3 = Date.now();
const shot = await client.send('Page.captureScreenshot', { format: 'png' });
console.log('screenshot in', Date.now() - t3, 'ms, base64 bytes', shot.data.length);
const png = Buffer.from(shot.data, 'base64');
const { writeFileSync } = await import('node:fs');
writeFileSync(join(HERE, 'cdp-shot.png'), png);
check('screenshot is a png', png.length > 1000 && png.subarray(1, 4).toString() === 'PNG', png.length + ' bytes');

client.close();
check('browser closed', closeBrowser(launch.port));
console.log(failures === 0 ? 'cdp e2e: all checks passed' : 'cdp e2e: ' + failures + ' failed');
process.exit(failures === 0 ? 0 : 1);