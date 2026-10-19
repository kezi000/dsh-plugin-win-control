/**
 * uia.js - warm client for the PowerShell UI Automation worker.
 *
 * Spawning PowerShell costs ~250 ms; the worker is therefore started once and
 * kept warm, so a tree/invoke round trip is ~10-40 ms. Requests are serialized
 * (one in flight at a time) because the protocol is strictly line-for-line.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

export function defaultWorkerScript() {
  return join(HERE, 'uia-worker.ps1');
}

/**
 * Create a worker handle. start() runs lazily on the first request.
 * @param {{ scriptPath?: string, powershellPath?: string, readyTimeoutMs?: number }} [options]
 */
export function createUiaWorker(options = {}) {
  const scriptPath = options.scriptPath ?? defaultWorkerScript();
  const powershellPath = options.powershellPath ?? join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const readyTimeoutMs = options.readyTimeoutMs ?? 15000;

  let child = null;
  let readyPromise = null;
  let buffer = '';
  let pending = null;
  let closed = false;
  const queue = [];
  let stderrTail = '';

  function failAll(error) {
    if (pending) {
      const current = pending;
      pending = null;
      clearTimeout(current.timer);
      current.reject(error);
    }
    while (queue.length > 0) {
      const task = queue.shift();
      clearTimeout(task.timer);
      task.reject(error);
    }
  }

  function dispatch() {
    if (!child || pending || queue.length === 0) return;
    const task = queue.shift();
    pending = task;
    task.timer = setTimeout(() => {
      if (pending === task) {
        pending = null;
        task.reject(new Error('UI Automation request timed out after ' + task.timeoutMs + ' ms'));
        dispatch();
      }
    }, task.timeoutMs);
    if (task.timer.unref) task.timer.unref();
    try {
      child.stdin.write(task.line + '\n', 'utf8');
    } catch (error) {
      clearTimeout(task.timer);
      pending = null;
      task.reject(error);
    }
  }

  function onLine(line) {
    const text = line.trim();
    if (text === '') return;
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      if (process.env.DSH_WIN_CONTROL_DEBUG) process.stderr.write('[uia] non-JSON line: ' + text + '\n');
      return;
    }
    if (payload.ready === true && !pending) {
      if (readyHook) readyHook(payload);
      return;
    }
    if (!pending) return;
    const task = pending;
    pending = null;
    clearTimeout(task.timer);
    task.resolve(payload);
    dispatch();
  }

  let readyHook = null;

  function start() {
    if (readyPromise) return readyPromise;
    readyPromise = new Promise((resolve, reject) => {
      child = spawn(powershellPath, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        reject(new Error('UI Automation worker did not become ready within ' + readyTimeoutMs + ' ms' + (stderrTail ? ' - stderr: ' + stderrTail : '')));
      }, readyTimeoutMs);
      if (timer.unref) timer.unref();
      readyHook = () => {
        clearTimeout(timer);
        resolve();
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          onLine(line);
          newline = buffer.indexOf('\n');
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk).slice(-2000);
      });
      child.on('exit', (code) => {
        const wasClosed = closed;
        child = null;
        readyPromise = null;
        readyHook = null;
        pending = null;
        if (!wasClosed) failAll(new Error('UI Automation worker exited (code ' + code + ')' + (stderrTail ? ' - stderr: ' + stderrTail : '')));
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return readyPromise;
  }

  function request(cmd, payload = {}, timeoutMs = 15000) {
    return start().then(() => new Promise((resolve, reject) => {
      queue.push({ line: JSON.stringify({ cmd, ...payload }), resolve, reject, timeoutMs, timer: null });
      dispatch();
    }));
  }

  return {
    start,
    request,
    isRunning: () => child !== null,
    stderr: () => stderrTail,
    close() {
      closed = true;
      failAll(new Error('UI Automation worker closed'));
      if (child) {
        try { child.stdin.end(); } catch {}
        try { child.kill(); } catch {}
        child = null;
      }
      readyPromise = null;
      readyHook = null;
    },
  };
}
