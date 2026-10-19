/**
 * index.js - dsh-plugin-win-control cordis plugin entry.
 *
 * Nine model-facing tools for driving the local Windows desktop without stealing
 * the user's mouse or keyboard:
 *   win_list_windows, win_window_info, win_screen_info
 *   win_uia_tree, win_uia_find, win_uia_invoke, win_uia_set_value
 *   win_click, win_type_text (message-based, no synthetic input)
 *   win_capture (offscreen PrintWindow, never raises the window)
 *
 * Read paths use koffi + user32 directly (~2 ms to enumerate 1700 windows); the
 * UI Automation paths run through one warm PowerShell worker (~10-40 ms/call).
 */
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listWindows, windowInfo, screenInfo, captureWindow } from './native.js';
import { encodePng, bgraToRgba } from './png.js';
import { createUiaWorker } from './uia.js';
import { clickWindow, typeIntoWindow } from './input.js';
import { activateWindow, sendKeys } from './keys.js';
import {
  listTargets,
  createCdpClient,
  launchBrowser,
  closeBrowser,
  defaultBrowserPath,
  snapshotPage,
  clickPage,
  typePage,
  clickPageByText,
  waitForDocumentReady,
} from './cdp.js';

const RECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    x: { type: 'integer', required: true },
    y: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
  },
};

const WINDOW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    hwnd: { type: 'string', required: true },
    title: { type: 'string', required: true },
    class: { type: 'string', required: true },
    pid: { type: 'integer', required: true },
    exe: { type: 'string', required: true },
    rect: { ...RECT_SCHEMA, required: true },
    visible: { type: 'boolean', required: true },
    minimized: { type: 'boolean', required: true },
    toolWindow: { type: 'boolean', required: true },
    foreground: { type: 'boolean', required: true },
  },
};

const NODE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'integer', required: true },
    depth: { type: 'integer', required: true },
    path: { type: 'array', required: true, items: { type: 'integer' } },
    name: { type: 'string', required: true },
    controlType: { type: 'string', required: true },
    automationId: { type: 'string', required: true },
    className: { type: 'string', required: true },
    enabled: { type: 'boolean', required: true },
    offscreen: { type: 'boolean', required: true },
    focusable: { type: 'boolean', required: true },
    focused: { type: 'boolean', required: true },
    patterns: { type: 'array', required: true, items: { type: 'string' } },
  },
};

/**
 * Drop undefined-valued keys so the result is a lossless JSON value.
 * The harness rejects tool outputs that still carry `undefined`.
 */
function compact(value) {
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out;
}

function textOnly(text) {
  return () => [{ type: 'text', text }];
}

function lines(list) {
  return list.filter((line) => line !== '').join('\n');
}

function renderWindowList(value) {
  const out = ['Foreground: ' + value.foreground, 'Windows: ' + value.count + ' (enumeration ' + value.elapsed_ms.toFixed(1) + ' ms)'];
  for (const w of value.windows) {
    const marks = [];
    if (w.foreground) marks.push('FOREGROUND');
    if (w.minimized) marks.push('minimized');
    out.push('');
    out.push(w.hwnd + '  ' + JSON.stringify(w.title.slice(0, 80)));
    out.push('  exe=' + w.exe + (marks.length ? '  [' + marks.join(', ') + ']' : ''));
    out.push('  class=' + w['class'] + '  pid=' + w.pid + '  rect=' + w.rect.x + ',' + w.rect.y + ' ' + w.rect.width + 'x' + w.rect.height);
  }
  return [{ type: 'text', text: out.join('\n') }];
}

function renderTree(value) {
  const out = ['Window ' + value.hwnd + ' -> ' + value.count + ' nodes (' + value.elapsed_ms.toFixed(1) + ' ms)'];
  if (value.error) out.push('error: ' + value.error);
  for (const n of value.nodes) {
    const bits = [n.controlType];
    if (n.name) bits.push('name=' + JSON.stringify(n.name.slice(0, 60)));
    bits.push('autoId=' + JSON.stringify(n.automationId));
    if (n.focused) bits.push('FOCUSED');
    if (!n.enabled) bits.push('disabled');
    if (n.offscreen) bits.push('offscreen');
    if (n.patterns.length > 0) bits.push('<' + n.patterns.join(',') + '>');
    out.push('  '.repeat(n.depth) + '[' + n.id + '] ' + bits.join(' '));
  }
  if (value.count === 0) out.push('No nodes: this window exposes no UI Automation tree (common for custom-drawn or accessibility-disabled apps). Use win_capture and win_click instead.');
  return [{ type: 'text', text: out.join('\n') }];
}

function renderNodes(value) {
  if (!value.ok) return [{ type: 'text', text: 'failed: ' + (value.error || value.reason || 'unknown error') }];
  const out = [(value.total !== null ? value.total + ' match(es)' : 'ok') + ' (' + value.elapsed_ms.toFixed(1) + ' ms)'];
  for (const n of value.nodes) {
    const bits = [n.controlType];
    if (n.name) bits.push('name=' + JSON.stringify(n.name.slice(0, 60)));
    if (n.automationId) bits.push('autoId=' + JSON.stringify(n.automationId));
    if (n.patterns.length > 0) bits.push('<' + n.patterns.join(',') + '>');
    out.push('  ' + bits.join(' '));
  }
  return [{ type: 'text', text: out.join('\n') }];
}
async function resolveTarget(port, spec, timeoutMs) {
  const targets = await listTargets(port, timeoutMs);
  if (targets.length === 0) throw new Error('no page targets on port ' + port);
  if (spec === undefined || spec === null || spec === '') return targets[0];
  const wanted = String(spec);
  const exact = targets.find((t) => t.id === wanted);
  if (exact) return exact;
  const byUrl = targets.find((t) => t.url.includes(wanted) || (t.title || '').includes(wanted));
  if (byUrl) return byUrl;
  const index = Number(wanted);
  if (Number.isInteger(index) && index >= 0 && index < targets.length) return targets[index];
  throw new Error('no page target matched ' + JSON.stringify(wanted) + '; candidates: ' + targets.map((t) => t.title + ' | ' + t.url).join(' ; '));
}

const CDP_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    port: { type: 'integer', required: true },
    target_id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    url: { type: 'string', required: true },
    elapsed_ms: { type: 'number', required: true },
    error: { type: 'string' },
  },
};

function registerTools(ctx, deps) {
  ctx.tools.register(defineTool({
    name: 'win_list_windows',
    description: 'List top-level Windows desktop windows: handle, title, class, process id, executable path, rectangle, visibility, minimized state and whether it is the foreground window. Filter by title or executable substring. Pure Win32 query (~2-20 ms); never touches the mouse or keyboard and never raises a window.',
    parameters: {
      query: { type: 'string', description: 'Case-insensitive substring matched against window title and executable path.' },
      include_tool_windows: { type: 'boolean', description: 'Include tool windows (no taskbar entry, e.g. floating palettes). Defaults to false.' },
      include_hidden: { type: 'boolean', description: 'Include invisible windows. Defaults to false.' },
      include_untitled: { type: 'boolean', description: 'Include windows with an empty title. Defaults to false.' },
      limit: { type: 'integer', description: 'Maximum number of windows to return (default 40, max 400).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          foreground: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          total: { type: 'integer', required: true },
          elapsed_ms: { type: 'number', required: true },
          windows: { type: 'array', required: true, items: WINDOW_SCHEMA },
        },
      },
      render: (_args, value) => renderWindowList(value),
    },
    async execute(args) {
      const result = listWindows({
        visibleOnly: args.include_hidden !== true,
        includeToolWindows: args.include_tool_windows === true,
        titleOnly: args.include_untitled !== true,
      });
      let rows = result.windows;
      const query = (args.query || '').trim().toLowerCase();
      if (query !== '') rows = rows.filter((w) => w.title.toLowerCase().includes(query) || w.exe.toLowerCase().includes(query));
      const total = rows.length;
      const limit = Math.min(Math.max(args.limit ?? 40, 1), 400);
      rows = rows.slice(0, limit).map((w) => ({
        hwnd: w.hwnd, title: w.title, class: w['class'], pid: w.pid, exe: w.exe,
        rect: w.rect ?? { x: 0, y: 0, width: 0, height: 0 },
        visible: w.visible, minimized: w.minimized, toolWindow: w.toolWindow, foreground: w.foreground,
      }));
      return { foreground: result.foreground, count: rows.length, total, elapsed_ms: result.elapsedMs, windows: rows };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'win_window_info',
    description: 'Describe one window by handle: title, class, process, rectangle, visibility, minimized and foreground state, plus the current cursor position. Read-only.',
    parameters: { hwnd: { type: 'string', description: 'Window handle from win_list_windows, e.g. "0x0000000002BA1BBA".', required: true } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          window: { ...WINDOW_SCHEMA, required: true },
          cursor: { type: 'object', required: true, additionalProperties: false, properties: { x: { type: 'integer', required: true }, y: { type: 'integer', required: true } } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: lines([
        value.window.hwnd + '  ' + JSON.stringify(value.window.title),
        '  exe=' + value.window.exe,
        '  class=' + value.window['class'] + '  pid=' + value.window.pid,
        '  rect=' + value.window.rect.x + ',' + value.window.rect.y + ' ' + value.window.rect.width + 'x' + value.window.rect.height,
        '  visible=' + value.window.visible + '  minimized=' + value.window.minimized + '  foreground=' + value.window.foreground,
        '  cursor=' + value.cursor.x + ',' + value.cursor.y,
      ]) }],
    },
    async execute(args) {
      const info = windowInfo(args.hwnd);
      if (!info.rect) throw new Error('window ' + args.hwnd + ' has no rectangle (it may have just closed)');
      return {
        window: {
          hwnd: info.hwnd, title: info.title, class: info['class'], pid: info.pid, exe: info.exe,
          rect: info.rect, visible: info.visible, minimized: info.minimized, toolWindow: info.toolWindow, foreground: info.foreground,
        },
        cursor: info.cursor,
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'win_screen_info',
    description: 'Report the primary screen size and the current cursor position. Read-only and effectively instant.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          screen: { type: 'object', required: true, additionalProperties: false, properties: { width: { type: 'integer', required: true }, height: { type: 'integer', required: true } } },
          cursor: { type: 'object', required: true, additionalProperties: false, properties: { x: { type: 'integer', required: true }, y: { type: 'integer', required: true } } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: 'screen ' + value.screen.width + 'x' + value.screen.height + ', cursor ' + value.cursor.x + ',' + value.cursor.y }],
    },
    async execute() {
      return screenInfo();
    },
  }));
  ctx.tools.register(defineTool({
    name: 'win_uia_tree',
    description: 'Read the UI Automation tree of a window: control type, name, automation id, class, enabled/offscreen/focus flags and the patterns each element supports. Nodes carry a breadth-first id plus a child-index path usable by win_uia_invoke and win_uia_set_value. Read-only: it never clicks, focuses or raises the window. Depth-first apps with a huge tree can be bounded with max_depth / max_nodes.',
    parameters: {
      hwnd: { type: 'string', description: 'Window handle from win_list_windows.', required: true },
      max_depth: { type: 'integer', description: 'Tree depth limit (default 8, max 32).' },
      max_nodes: { type: 'integer', description: 'Node budget (default 400, max 4000).' },
      include_offscreen: { type: 'boolean', description: 'Include elements the app reports as offscreen. Defaults to false.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          hwnd: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          elapsed_ms: { type: 'number', required: true },
          error: { type: 'string' },
          nodes: { type: 'array', required: true, items: NODE_SCHEMA },
        },
      },
      render: (_args, value) => renderTree(value),
    },
    async execute(args) {
      const hwnd = normalizeHwnd(args.hwnd);
      const reply = await deps.uia().request('tree', {
        hwnd,
        maxDepth: Math.min(Math.max(args.max_depth ?? 8, 1), 32),
        maxNodes: Math.min(Math.max(args.max_nodes ?? deps.config().uiaMaxNodes, 1), 4000),
        includeOffscreen: args.include_offscreen === true,
      }, deps.config().uiaTimeoutMs);
      const nodes = (reply.nodes || []).map(toNodeEntry);
      return compact({
        ok: reply.ok === true,
        hwnd: args.hwnd,
        count: nodes.length,
        elapsed_ms: typeof reply.elapsedMs === 'number' ? reply.elapsedMs : 0,
        error: reply.ok === true ? undefined : String(reply.error || 'unknown error'),
        nodes,
      });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'win_uia_find',
    description: 'Find UI Automation elements inside a window by name, automation id, class name and/or control type. Returns matches with their supported patterns, so you can tell in advance whether the element can be invoked or value-set without synthetic input. Read-only.',
    parameters: {
      hwnd: { type: 'string', description: 'Window handle from win_list_windows.', required: true },
      name: { type: 'string', description: 'Exact element name (button caption, label text, edit content).' },
      automation_id: { type: 'string', description: 'Exact AutomationId.' },
      class_name: { type: 'string', description: 'Exact window class name, e.g. "Button" or "Edit".' },
      control_type: { type: 'string', description: 'Exact control type without the ControlType. prefix, e.g. "Button", "Edit", "ListItem".' },
      shallow: { type: 'boolean', description: 'Search direct children only instead of all descendants. Defaults to false.' },
      limit: { type: 'integer', description: 'Maximum matches to return (default 20, max 200).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          total: { type: 'integer', required: true },
          elapsed_ms: { type: 'number', required: true },
          error: { type: 'string' },
          nodes: { type: 'array', required: true, items: NODE_SCHEMA },
        },
      },
      render: (_args, value) => renderNodes(value),
    },
    async execute(args) {
      const hwnd = normalizeHwnd(args.hwnd);
      const reply = await deps.uia().request('find', {
        hwnd,
        name: args.name,
        automationId: args.automation_id,
        className: args.class_name,
        controlType: args.control_type,
        shallow: args.shallow === true,
        limit: Math.min(Math.max(args.limit ?? 20, 1), 200),
      }, deps.config().uiaTimeoutMs);
      return compact({
        ok: reply.ok === true,
        total: typeof reply.total === 'number' ? reply.total : 0,
        elapsed_ms: typeof reply.elapsedMs === 'number' ? reply.elapsedMs : 0,
        error: reply.ok === true ? undefined : String(reply.error || 'unknown error'),
        nodes: (reply.nodes || []).map(toNodeEntry),
      });
    },
  }));
  ctx.tools.register(defineTool({
    name: 'win_uia_invoke',
    description: 'Activate a UI Automation element with its own pattern (Invoke / SelectionItem / Toggle), so no mouse or keyboard input is synthesized and the window is not raised. Select the element by child-index path or by name / automation id / class / control type. If the element exposes no usable pattern the call fails and tells you so; fall back to win_click with screen coordinates then.',
    parameters: {
      hwnd: { type: 'string', description: 'Window handle from win_list_windows.', required: true },
      path: { type: 'array', description: 'Child-index path reported by win_uia_tree (e.g. [0,2,1]).', items: { type: 'integer' } },
      name: { type: 'string', description: 'Exact element name.' },
      automation_id: { type: 'string', description: 'Exact AutomationId.' },
      class_name: { type: 'string', description: 'Exact class name.' },
      control_type: { type: 'string', description: 'Exact control type without the ControlType. prefix.' },
      index: { type: 'integer', description: 'Which match to use when several elements match (default 0).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          method: { type: 'array', required: true, items: { type: 'string' } },
          elapsed_ms: { type: 'number', required: true },
          error: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => renderAction(value),
    },
    async execute(args) {
      return runUiaAction(deps, 'invoke', args);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'win_uia_set_value',
    description: 'Write a string into a UI Automation element through ValuePattern (or the legacy pattern as a fallback). No keystrokes are synthesized. Use this for edit boxes, combo boxes and document fields that expose a value pattern.',
    parameters: {
      hwnd: { type: 'string', description: 'Window handle from win_list_windows.', required: true },
      value: { type: 'string', description: 'The text to write.', required: true },
      path: { type: 'array', description: 'Child-index path from win_uia_tree.', items: { type: 'integer' } },
      name: { type: 'string', description: 'Exact element name.' },
      automation_id: { type: 'string', description: 'Exact AutomationId.' },
      class_name: { type: 'string', description: 'Exact class name.' },
      control_type: { type: 'string', description: 'Exact control type without the ControlType. prefix.' },
      index: { type: 'integer', description: 'Which match to use when several elements match (default 0).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          method: { type: 'array', required: true, items: { type: 'string' } },
          elapsed_ms: { type: 'number', required: true },
          error: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => renderAction(value),
    },
    async execute(args) {
      return runUiaAction(deps, 'setvalue', args);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'win_click',
    description: 'Click inside a window by posting mouse messages to the deepest child window under the point. The physical cursor does not move and no window is raised, so the click does not interrupt the user. Coordinates are screen pixels (the space used by UI Automation rectangles) unless space is set to client. Apps that ignore posted messages (games, some custom UIs) will not react.',
    parameters: {
      hwnd: { type: 'string', description: 'Window handle from win_list_windows.', required: true },
      x: { type: 'integer', description: 'X in screen pixels.', required: true },
      y: { type: 'integer', description: 'Y in screen pixels.', required: true },
      space: { type: 'string', enum: ['screen', 'client'], description: 'Coordinate space: screen (default) or the window client area.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target_hwnd: { type: 'string', required: true },
          depth: { type: 'integer', required: true },
          client_x: { type: 'integer', required: true },
          client_y: { type: 'integer', required: true },
          elapsed_ms: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: 'clicked ' + value.target_hwnd + ' at client ' + value.client_x + ',' + value.client_y + ' (descended ' + value.depth + ' level(s), ' + value.elapsed_ms.toFixed(2) + ' ms)' }],
    },
    async execute(args) {
      const r = clickWindow(args.hwnd, { x: args.x, y: args.y, space: args.space === 'client' ? 'client' : 'screen' });
      return { target_hwnd: r.targetHwnd, depth: r.depth, client_x: r.clientX, client_y: r.clientY, elapsed_ms: r.elapsedMs };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'win_type_text',
    description: 'Type text into a window or a specific child control by posting WM_CHAR messages. No global keystrokes and no focus change, so whatever the user is typing continues to land in their own window. Provide at={x,y} (screen pixels) to target the control under that point, or target_hwnd for an explicit child window.',
    parameters: {
      hwnd: { type: 'string', description: 'Window handle from win_list_windows.', required: true },
      text: { type: 'string', description: 'Text to type.', required: true },
      at_x: { type: 'integer', description: 'X in screen pixels of the control to receive the text.' },
      at_y: { type: 'integer', description: 'Y in screen pixels of the control to receive the text.' },
      target_hwnd: { type: 'string', description: 'Explicit child window handle that receives the characters.' },
      submit: { type: 'boolean', description: 'Press Enter after the text. Defaults to false.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target_hwnd: { type: 'string', required: true },
          characters: { type: 'integer', required: true },
          skipped: { type: 'array', required: true, items: { type: 'string' } },
          elapsed_ms: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: 'posted ' + value.characters + ' character(s) to ' + value.target_hwnd + ' (' + value.elapsed_ms.toFixed(2) + ' ms)' + (value.skipped.length ? ' — skipped non-BMP: ' + value.skipped.join(',') : '') }],
    },
    async execute(args) {
      const hasPoint = typeof args.at_x === 'number' && typeof args.at_y === 'number';
      const r = typeIntoWindow(args.hwnd, {
        text: args.text,
        submit: args.submit === true,
        targetHwnd: args.target_hwnd,
        at: hasPoint ? { x: args.at_x, y: args.at_y } : undefined,
      });
      return { target_hwnd: r.targetHwnd, characters: r.characters, skipped: r.skipped, elapsed_ms: r.elapsedMs };
    },
  }));
  ctx.tools.register(defineTool({
    name: 'win_capture',
    description: 'Capture a window offscreen with PrintWindow and deliver it as a PNG. The window is never raised or resized and nothing is drawn on screen: it works while the window is covered or minimized. ~11-25 ms for a 1080p-ish window. Use it to see custom-drawn UIs that expose no UI Automation tree.',
    parameters: {
      hwnd: { type: 'string', description: 'Window handle from win_list_windows.', required: true },
      save: { type: 'boolean', description: 'Keep a copy under the configured capture directory. Defaults to true.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hwnd: { type: 'string', required: true },
          title: { type: 'string', required: true },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
          bytes: { type: 'integer', required: true },
          method: { type: 'string', required: true },
          elapsed_ms: { type: 'number', required: true },
          saved_path: { type: 'string' },
          image_emitted: { type: 'boolean', required: true },
          image: {
            type: 'object',
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (_args, value) => {
        const blocks = [{ type: 'text', text: lines([
          'captured ' + value.hwnd + ' ' + JSON.stringify(value.title.slice(0, 60)),
          '  ' + value.width + 'x' + value.height + ', ' + value.bytes + ' bytes PNG via ' + value.method + ' (' + value.elapsed_ms.toFixed(1) + ' ms)',
          value.saved_path ? '  saved: ' + value.saved_path : '',
          value.image_emitted ? 'Image emitted to model context.' : 'Image not emitted to the model context (the retained file still shows it).',
        ]) }];
        if (value.image_emitted && value.image) {
          blocks.push({ type: 'image', attachment: {
            attachmentId: value.image.attachmentId,
            mediaType: value.image.mediaType,
            bytes: value.image.bytes,
            width: value.image.width,
            height: value.image.height,
          } });
        }
        return blocks;
      },
    },
    async execute(args) {
      const config = deps.config();
      const info = windowInfo(args.hwnd);
      const shot = captureWindow(args.hwnd);
      const png = encodePng(bgraToRgba(shot.bgra), shot.width, shot.height);
      let saved = null;
      if (args.save !== false) {
        const dir = config.captureDir;
        await mkdir(dir, { recursive: true });
        const name = 'win-' + Date.now() + '-' + args.hwnd.replace(/^0x/, '').slice(-8) + '.png';
        saved = join(dir, name);
        await writeFile(saved, png);
        await pruneCaptures(dir, config.captureKeep);
      }
      let image = null;
      const attachments = ctx.get('attachments');
      if (attachments !== undefined) {
        const ref = await attachments.saveImage({ data: png, mediaType: 'image/png', name: 'win_capture.png' });
        image = { attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height };
      }
      return compact({
        hwnd: info.hwnd,
        title: info.title,
        width: shot.width,
        height: shot.height,
        bytes: png.length,
        method: shot.method,
        elapsed_ms: shot.elapsedMs,
        saved_path: saved ?? undefined,
        image_emitted: image !== null,
        image: image ?? undefined,
      });
    },
  }));
  /* ------------------------------------------------------ CDP: Chromium pages */

  ctx.tools.register(defineTool({
    name: 'cdp_launch',
    description: 'Start an isolated Chromium (Chrome/Edge) with a loopback DevTools port and a throwaway profile, then return its port and first page target. This is the precise, non-intrusive way to drive a browser: the instance is separate from the user windows, so nothing is stolen from them.',
    parameters: {
      url: { type: 'string', description: 'Page to open, e.g. https://example.com or file:///C:/path/page.html.' },
      headless: { type: 'boolean', description: 'Run without a window. Defaults to false so the user can watch.' },
      browser: { type: 'string', description: 'Explicit chrome.exe/msedge.exe path. Defaults to the first installed Chromium browser.' },
      width: { type: 'integer', description: 'Initial window width (default 1280).' },
      height: { type: 'integer', description: 'Initial window height (default 900).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          port: { type: 'integer', required: true },
          pid: { type: 'integer', required: true },
          browser: { type: 'string', required: true },
          user_data_dir: { type: 'string', required: true },
          target_id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          url: { type: 'string', required: true },
          ready_state: { type: 'string' },
          elapsed_ms: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: lines([
        'browser ready on port ' + value.port + ' (pid ' + value.pid + ', ' + value.elapsed_ms.toFixed(0) + ' ms)',
        '  browser: ' + value.browser,
        '  profile: ' + value.user_data_dir,
        '  page: ' + JSON.stringify(value.title) + ' ' + value.url,
        'Next: cdp_snapshot { port: ' + value.port + ' }',
      ]) }],
    },
    async execute(args) {
      const browser = args.browser || deps.config().browserPath || defaultBrowserPath();
      if (!browser) throw new Error('no Chromium browser found; pass the browser path explicitly');
      const started = Date.now();
      const launch = await launchBrowser({
        browserPath: browser,
        headless: args.headless === true,
        url: args.url,
        width: args.width,
        height: args.height,
      });
      const config = deps.config();
      // Wait for the requested page (not the transient about:blank) to commit,
      // so the very next cdp_eval already sees the real document.
      let page = null;
      const deadline = Date.now() + config.cdpTimeoutMs;
      while (Date.now() < deadline) {
        const targets = await listTargets(launch.port, config.cdpTimeoutMs);
        page = targets.find((entry) => entry.url && entry.url !== 'about:blank') ?? null;
        if (page !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (page === null) {
        const targets = await listTargets(launch.port, config.cdpTimeoutMs);
        page = targets[0] ?? null;
      }
      const requested = typeof args.url === 'string' && args.url !== '' ? new URL(args.url, 'https://x/') : null;
      // file:// URLs have no host, so fall back to the path for the readiness check.
      const urlFragment = requested === null ? '' : (requested.host !== '' ? requested.host : decodeURIComponent(requested.pathname));
      let readyState = 'unknown';
      let resolvedTitle = page === null ? '' : page.title;
      let resolvedUrl = page === null ? '' : page.url;
      if (page !== null) {
        try {
          const client = await deps.cdp(launch.port, page);
          const ready = await waitForDocumentReady(client, Math.min(config.cdpTimeoutMs, 15000), urlFragment);
          readyState = ready.readyState;
          if (ready.title !== '') resolvedTitle = ready.title;
          if (ready.url !== '') resolvedUrl = ready.url;
        } catch {
          readyState = 'unknown';
        }
      }
      return {
        ok: true, port: launch.port, pid: launch.pid, browser,
        user_data_dir: launch.userDataDir,
        target_id: page ? page.id : '',
        title: resolvedTitle,
        url: resolvedUrl,
        ready_state: readyState,
        elapsed_ms: Date.now() - started,
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cdp_targets',
    description: 'List page targets on a loopback DevTools port (pages, webviews) with ids, titles and URLs. Use it to pick a target for the other cdp_* tools, or to discover what a running Chromium/Electron instance exposes.',
    parameters: { port: { type: 'integer', description: 'DevTools port. Defaults to the configured port (9222).' } },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          port: { type: 'integer', required: true },
          count: { type: 'integer', required: true },
          targets: { type: 'array', required: true, items: {
            type: 'object', additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              type: { type: 'string', required: true },
              title: { type: 'string', required: true },
              url: { type: 'string', required: true },
            },
          } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: 'port ' + value.port + ': ' + value.count + ' target(s)\n' + value.targets.map((t) => '  ' + t.id.slice(0, 12) + '  ' + JSON.stringify(t.title) + '  ' + t.url.slice(0, 90)).join('\n') }],
    },
    async execute(args) {
      const port = args.port ?? deps.config().cdpPort;
      const targets = await listTargets(port, deps.config().cdpTimeoutMs);
      return { ok: true, port, count: targets.length, targets: targets.map((t) => ({ id: t.id, type: t.type, title: t.title, url: t.url })) };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cdp_snapshot',
    description: 'Read the page as structured data: every visible interactive element (button, input, link, [role], tabindex) with a stable CSS ref plus text/value, and the visible text blocks. A few milliseconds, renderer-only. Feed the refs to cdp_click / cdp_type.',
    parameters: {
      port: { type: 'integer', description: 'DevTools port (default 9222, or the port returned by cdp_launch).' },
      target: { type: 'string', description: 'Target id, URL substring or index from cdp_targets. Defaults to the first page.' },
      max_nodes: { type: 'integer', description: 'Node budget (default 150, max 1000).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          port: { type: 'integer', required: true },
          target_id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          url: { type: 'string', required: true },
          elapsed_ms: { type: 'number', required: true },
          truncated: { type: 'boolean', required: true },
          interactive: { type: 'array', required: true, items: {
            type: 'object', additionalProperties: false,
            properties: {
              ref: { type: 'string', required: true },
              tag: { type: 'string', required: true },
              role: { type: 'string', required: true },
              type: { type: 'string', required: true },
              text: { type: 'string', required: true },
              value: { type: 'string', required: true },
              placeholder: { type: 'string', required: true },
              disabled: { type: 'boolean', required: true },
            },
          } },
          text_blocks: { type: 'array', required: true, items: {
            type: 'object', additionalProperties: false,
            properties: { ref: { type: 'string', required: true }, tag: { type: 'string', required: true }, text: { type: 'string', required: true } },
          } },
        },
      },
      render: (_args, value) => {
        const out = [value.title + '  ' + value.url + '  (' + value.elapsed_ms.toFixed(1) + ' ms)'];
        out.push('interactive: ' + value.interactive.length);
        for (const row of value.interactive) {
          const bits = [row.tag];
          if (row.role) bits.push('[' + row.role + ']');
          if (row.text) bits.push(JSON.stringify(row.text.slice(0, 50)));
          if (row.value) bits.push('value=' + JSON.stringify(row.value.slice(0, 30)));
          if (row.placeholder) bits.push('placeholder=' + JSON.stringify(row.placeholder));
          if (row.disabled) bits.push('disabled');
          out.push('  ' + bits.join(' '));
          out.push('      ' + row.ref);
        }
        if (value.text_blocks.length) {
          out.push('text: ' + value.text_blocks.length);
          for (const row of value.text_blocks.slice(0, 20)) out.push('  ' + JSON.stringify(row.text.slice(0, 80)));
        }
        return [{ type: 'text', text: out.join('\n') }];
      },
    },
    async execute(args) {
      const port = args.port ?? deps.config().cdpPort;
      const started = Date.now();
      const target = await resolveTarget(port, args.target, deps.config().cdpTimeoutMs);
      const client = await deps.cdp(port, target);
      const snap = await snapshotPage(client, Math.min(Math.max(args.max_nodes ?? 150, 1), 1000));
      return {
        ok: true, port, target_id: target.id, title: snap.title, url: snap.url,
        elapsed_ms: Date.now() - started,
        truncated: snap.truncated === true,
        interactive: snap.interactive.map((row) => ({ ref: row.ref, tag: row.tag, role: row.role, type: row.type, text: row.text, value: row.value, placeholder: row.placeholder, disabled: row.disabled === true })),
        text_blocks: snap.text.map((row) => ({ ref: row.ref, tag: row.tag, text: row.text })),
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cdp_click',
    description: 'Click an element in the page by CSS ref (from cdp_snapshot) or by its visible text. Dispatches pointer/mouse events inside the renderer only: no OS input is synthesized and the user cursor/focus are untouched.',
    parameters: {
      port: { type: 'integer', description: 'DevTools port.' },
      target: { type: 'string', description: 'Target id, URL substring or index.' },
      selector: { type: 'string', description: 'CSS ref from cdp_snapshot.' },
      text: { type: 'string', description: 'Visible label to click instead of a CSS ref.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          target_id: { type: 'string', required: true },
          tag: { type: 'string', required: true },
          text: { type: 'string', required: true },
          elapsed_ms: { type: 'number', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.ok
        ? 'clicked <' + value.tag + '> ' + JSON.stringify(value.text) + ' (' + value.elapsed_ms.toFixed(1) + ' ms)'
        : 'failed: ' + (value.error || 'unknown') }],
    },
    async execute(args) {
      if (!args.selector && !args.text) throw new Error('pass selector or text');
      const port = args.port ?? deps.config().cdpPort;
      const started = Date.now();
      const target = await resolveTarget(port, args.target, deps.config().cdpTimeoutMs);
      const client = await deps.cdp(port, target);
      const reply = args.selector ? await clickPage(client, args.selector) : await clickPageByText(client, args.text);
      return compact({
        ok: reply.ok === true, target_id: target.id,
        tag: reply.tag || '', text: reply.text || '',
        elapsed_ms: Date.now() - started,
        error: reply.ok === true ? undefined : String(reply.reason || 'click failed'),
      });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cdp_type',
    description: 'Write text into a page input/textarea/contenteditable by CSS ref, using the native value setter so React/Vue controlled inputs pick the change up, then dispatch input and change events. Optional submit presses Enter and submits the owning form. Renderer-only: no OS keystrokes.',
    parameters: {
      port: { type: 'integer', description: 'DevTools port.' },
      target: { type: 'string', description: 'Target id, URL substring or index.' },
      selector: { type: 'string', description: 'CSS ref from cdp_snapshot.', required: true },
      text: { type: 'string', description: 'Text to write.', required: true },
      submit: { type: 'boolean', description: 'Press Enter and submit the form afterwards. Defaults to false.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          target_id: { type: 'string', required: true },
          value: { type: 'string', required: true },
          elapsed_ms: { type: 'number', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.ok
        ? 'typed, field now ' + JSON.stringify(value.value) + ' (' + value.elapsed_ms.toFixed(1) + ' ms)'
        : 'failed: ' + (value.error || 'unknown') }],
    },
    async execute(args) {
      const port = args.port ?? deps.config().cdpPort;
      const started = Date.now();
      const target = await resolveTarget(port, args.target, deps.config().cdpTimeoutMs);
      const client = await deps.cdp(port, target);
      const reply = await typePage(client, args.selector, args.text, args.submit === true);
      return compact({
        ok: reply.ok === true, target_id: target.id,
        value: reply.value || '',
        elapsed_ms: Date.now() - started,
        error: reply.ok === true ? undefined : String(reply.reason || 'type failed'),
      });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cdp_eval',
    description: 'Evaluate a JavaScript expression in the page and return its JSON result. The fastest way to read page state (text, attributes, storage) when a snapshot is too coarse.',
    parameters: {
      port: { type: 'integer', description: 'DevTools port.' },
      target: { type: 'string', description: 'Target id, URL substring or index.' },
      expression: { type: 'string', description: 'JavaScript expression, e.g. document.title.', required: true },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          target_id: { type: 'string', required: true },
          value_json: { type: 'string', required: true },
          elapsed_ms: { type: 'number', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.ok ? value.value_json : 'failed: ' + (value.error || 'unknown') }],
    },
    async execute(args) {
      const port = args.port ?? deps.config().cdpPort;
      const started = Date.now();
      const target = await resolveTarget(port, args.target, deps.config().cdpTimeoutMs);
      const client = await deps.cdp(port, target);
      try {
        const value = await client.evaluate(args.expression);
        return { ok: true, target_id: target.id, value_json: JSON.stringify(value, null, 2).slice(0, 20000), elapsed_ms: Date.now() - started };
      } catch (error) {
        return { ok: false, target_id: target.id, value_json: '', elapsed_ms: Date.now() - started, error: String(error && error.message ? error.message : error) };
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cdp_screenshot',
    description: 'Capture the page viewport through CDP and deliver it as a PNG. Renderer-side capture: the window need not be visible, raised or focused, and it works for a minimised or background page.',
    parameters: {
      port: { type: 'integer', description: 'DevTools port.' },
      target: { type: 'string', description: 'Target id, URL substring or index.' },
      save: { type: 'boolean', description: 'Keep a copy under the capture directory. Defaults to true.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          target_id: { type: 'string', required: true },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
          bytes: { type: 'integer', required: true },
          elapsed_ms: { type: 'number', required: true },
          saved_path: { type: 'string' },
          image_emitted: { type: 'boolean', required: true },
          image: { type: 'object', additionalProperties: false, properties: {
            attachmentId: { type: 'string', required: true },
            mediaType: { type: 'string', required: true },
            bytes: { type: 'integer', required: true },
            width: { type: 'integer', required: true },
            height: { type: 'integer', required: true },
          } },
        },
      },
      render: (_args, value) => {
        const blocks = [{ type: 'text', text: lines([
          'page screenshot ' + value.width + 'x' + value.height + ', ' + value.bytes + ' bytes (' + value.elapsed_ms.toFixed(1) + ' ms)',
          value.saved_path ? '  saved: ' + value.saved_path : '',
          value.image_emitted ? 'Image emitted to model context.' : 'Image not emitted to the model context.',
        ]) }];
        if (value.image_emitted && value.image) {
          blocks.push({ type: 'image', attachment: {
            attachmentId: value.image.attachmentId,
            mediaType: value.image.mediaType,
            bytes: value.image.bytes,
            width: value.image.width,
            height: value.image.height,
          } });
        }
        return blocks;
      },
    },
    async execute(args) {
      const config = deps.config();
      const port = args.port ?? config.cdpPort;
      const started = Date.now();
      const target = await resolveTarget(port, args.target, config.cdpTimeoutMs);
      const client = await deps.cdp(port, target);
      const shot = await client.send('Page.captureScreenshot', { format: 'png' }, config.cdpTimeoutMs);
      const png = Buffer.from(shot.data, 'base64');
      const width = png.length >= 24 ? png.readUInt32BE(16) : 0;
      const height = png.length >= 24 ? png.readUInt32BE(20) : 0;
      let saved = null;
      if (args.save !== false) {
        await mkdir(config.captureDir, { recursive: true });
        saved = join(config.captureDir, 'cdp-' + Date.now() + '.png');
        await writeFile(saved, png);
        await pruneCaptures(config.captureDir, config.captureKeep);
      }
      let image = null;
      const attachments = ctx.get('attachments');
      if (attachments !== undefined) {
        const ref = await attachments.saveImage({ data: png, mediaType: 'image/png', name: 'cdp_screenshot.png' });
        image = { attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height };
      }
      return compact({
        ok: true, target_id: target.id, width, height, bytes: png.length,
        elapsed_ms: Date.now() - started,
        saved_path: saved ?? undefined,
        image_emitted: image !== null,
        image: image ?? undefined,
      });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cdp_close',
    description: 'Close a browser that cdp_launch started, drop its cached CDP connections and delete its throwaway profile. Browsers you did not launch are left untouched.',
    parameters: { port: { type: 'integer', description: 'Port of a browser started by cdp_launch.', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, port: { type: 'integer', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.ok ? 'closed browser on port ' + value.port : 'port ' + value.port + ' was not started by cdp_launch; left as-is' }],
    },
    async execute(args) {
      deps.dropCdp(args.port);
      return { ok: closeBrowser(args.port), port: args.port };
    },
  }));

  /* ------------------------------------------- Intrusive lane: focus + keys */

  ctx.tools.register(defineTool({
    name: 'win_activate',
    description: 'HIGH IMPACT: bring a window to the foreground (restoring it if minimised). This takes focus away from the user, so use it only when a task genuinely requires an active window - for example before win_send_keys with mode=input. Prefer win_uia_invoke, win_click and win_type_text, which never steal focus.',
    parameters: { hwnd: { type: 'string', description: 'Window handle from win_list_windows.', required: true } },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          hwnd: { type: 'string', required: true },
          foreground: { type: 'string', required: true },
          is_foreground: { type: 'boolean', required: true },
          set_foreground_returned: { type: 'boolean', required: true },
          elapsed_ms: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: (value.is_foreground ? 'foreground is now ' : 'foreground request did not take effect; current is ') + value.foreground + ' (' + value.elapsed_ms.toFixed(1) + ' ms)' }],
    },
    async execute(args) {
      const r = activateWindow(args.hwnd);
      return { hwnd: r.hwnd, foreground: r.foreground, is_foreground: r.isForeground, set_foreground_returned: r.setForegroundWindowReturned, elapsed_ms: r.elapsedMs };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'win_send_keys',
    description: 'Send keystrokes. mode=post (default) posts WM_KEYDOWN/UP and WM_CHAR to the window focus control: the user keeps the keyboard and no global input is synthesized. mode=input activates the window and injects real SendInput events - use it only when an app ignores posted messages, and expect it to take focus. Tokens: Enter, Tab, Esc, Space, Backspace, Delete, Home, End, PageUp, PageDown, Up/Down/Left/Right, F1-F12, A-Z, 0-9, and combos like Ctrl+A or Shift+Tab.',
    parameters: {
      hwnd: { type: 'string', description: 'Window handle from win_list_windows.', required: true },
      keys: { type: 'array', description: 'Key tokens in order, e.g. ["Ctrl+A", "Delete", "Enter"].', required: true, items: { type: 'string' } },
      mode: { type: 'string', enum: ['post', 'input'], description: 'post (default, focus-safe) or input (real SendInput, takes focus).' },
      submit: { type: 'boolean', description: 'Send Enter after the tokens. Defaults to false.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          mode: { type: 'string', required: true },
          target: { type: 'string', required: true },
          sent: { type: 'array', required: true, items: { type: 'string' } },
          skipped: { type: 'array', required: true, items: { type: 'string' } },
          elapsed_ms: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.mode + ' lane -> ' + value.target + ': ' + (value.sent.join(' ') || '(nothing)') + (value.skipped.length ? ' / skipped: ' + value.skipped.join(', ') : '') + ' (' + value.elapsed_ms.toFixed(1) + ' ms)' }],
    },
    async execute(args) {
      const r = sendKeys(args.hwnd, { keys: args.keys, mode: args.mode === 'input' ? 'input' : 'post', submit: args.submit === true });
      return { mode: r.mode, target: r.target, sent: r.sent, skipped: r.skipped, elapsed_ms: r.elapsedMs };
    },
  }));

}

function toNodeEntry(n) {
  return {
    id: n.id,
    depth: n.depth,
    path: Array.isArray(n.path) ? n.path : [],
    name: n.name || '',
    controlType: n.controlType || '',
    automationId: n.automationId || '',
    className: n.className || '',
    enabled: n.enabled !== false,
    offscreen: n.offscreen === true,
    focusable: n.focusable === true,
    focused: n.focused === true,
    patterns: Array.isArray(n.patterns) ? n.patterns : [],
  };
}

function renderAction(value) {
  if (value.ok) {
    return [{ type: 'text', text: 'ok via ' + (value.method.length ? value.method.join(' -> ') : 'unknown pattern') + ' (' + value.elapsed_ms.toFixed(1) + ' ms)' }];
  }
  return [{ type: 'text', text: 'failed: ' + (value.reason || value.error || 'unknown error') }];
}

async function runUiaAction(deps, cmd, args) {
  const payload = {
    hwnd: normalizeHwnd(args.hwnd),
    path: Array.isArray(args.path) && args.path.length > 0 ? args.path : undefined,
    name: args.name,
    automationId: args.automation_id,
    className: args.class_name,
    controlType: args.control_type,
    index: typeof args.index === 'number' ? args.index : 0,
  };
  if (cmd === 'setvalue') payload.value = args.value;
  const reply = await deps.uia().request(cmd, payload, deps.config().uiaTimeoutMs);
  return compact({
    ok: reply.ok === true,
    method: Array.isArray(reply.method) ? reply.method : [],
    elapsed_ms: typeof reply.elapsedMs === 'number' ? reply.elapsedMs : 0,
    error: reply.error ? String(reply.error) : undefined,
    reason: reply.reason ? String(reply.reason) : undefined,
  });
}

function normalizeHwnd(text) {
  const raw = String(text).trim();
  if (raw === '') throw new Error('hwnd is required');
  return raw.toLowerCase().startsWith('0x') ? Number.parseInt(raw.slice(2), 16) : Number.parseInt(raw, 10);
}

async function pruneCaptures(dir, keep) {
  if (!Number.isFinite(keep) || keep <= 0) return;
  try {
    const names = await readdir(dir);
    const files = [];
    for (const name of names) {
      if (!name.endsWith('.png')) continue;
      const full = join(dir, name);
      const s = await stat(full);
      files.push({ full, mtime: s.mtimeMs });
    }
    if (files.length <= keep) return;
    files.sort((a, b) => a.mtime - b.mtime);
    for (const file of files.slice(0, files.length - keep)) {
      await unlink(file.full);
    }
  } catch {
    // Capture retention is best-effort; a failed prune must not fail the capture.
  }
}

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_FILE = join(SKILL_DIR, 'SKILL.md');

function parseSkillMarkdown(raw) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (front === null) return null;
  const head = front[1] ?? '';
  const skillName = /^name:[ \t]*(.+?)[ \t]*$/m.exec(head)?.[1];
  const description = /^description:[ \t]*(.+?)[ \t]*$/m.exec(head)?.[1];
  if (skillName === undefined || description === undefined) return null;
  return { name: skillName, description, content: raw.slice(front[0].length).trim() };
}

function registerBundledSkill(ctx, enabled) {
  if (!enabled) return;
  const skills = ctx.get('skills');
  if (skills === undefined || skills === null) return;
  let skill = null;
  try {
    skill = parseSkillMarkdown(readFileSync(SKILL_FILE, 'utf8'));
  } catch {
    skill = null;
  }
  if (skill === null) return;
  const resourceBase = { kind: 'directory', path: SKILL_DIR };
  // A live reload can meet the skill already registered; that is not fatal.
  try {
    ctx.effect(() => skills.register({
      name: skill.name,
      description: skill.description,
      content: skill.content,
      source: 'runtime',
      resourceBase,
    }), 'dsh-win-control: bundled skill');
  } catch (error) {
    if (ctx.logger && typeof ctx.logger.warn === 'function') {
      ctx.logger.warn('dsh-win-control: bundled skill not registered: ' + String(error && error.message ? error.message : error));
    }
  }
}

export const name = 'dsh-win-control';
export const inject = ['tools'];

export const Config = z.object({
  captureDir: z.string().description('Directory that keeps captured PNGs. Defaults to <system temp>/dsh-win-control.'),
  captureKeep: z.number().step(1).min(0).default(200).description('Maximum retained captures; the oldest are deleted first. 0 keeps everything.'),
  uiaMaxNodes: z.number().step(1).min(1).default(400).description('Default node budget for win_uia_tree when the caller does not pass max_nodes.'),
  uiaTimeoutMs: z.number().step(1).min(1000).default(20000).description('Per-request timeout for the UI Automation worker.'),
  powershellPath: z.string().description('PowerShell executable used for the UI Automation worker. Defaults to the system Windows PowerShell 5.1.'),
  cdpPort: z.number().step(1).min(1).default(9222).description('Default loopback DevTools port used when a cdp_* call omits port.'),
  cdpTimeoutMs: z.number().step(1).min(500).default(10000).description('Per-request timeout for CDP calls and target discovery.'),
  browserPath: z.string().description('Chromium browser executable for cdp_launch. Defaults to the first installed Chrome/Edge.'),
  provideSkill: z.boolean().default(true).description('Register the bundled win-control skill on ctx.skills when the profile mounts a skills service.'),
});

export function resolveConfig(config = {}) {
  return {
    captureDir: typeof config.captureDir === 'string' && config.captureDir !== '' ? config.captureDir : join(tmpdir(), 'dsh-win-control'),
    captureKeep: typeof config.captureKeep === 'number' && Number.isInteger(config.captureKeep) && config.captureKeep >= 0 ? config.captureKeep : 200,
    uiaMaxNodes: typeof config.uiaMaxNodes === 'number' && Number.isInteger(config.uiaMaxNodes) && config.uiaMaxNodes >= 1 ? config.uiaMaxNodes : 400,
    uiaTimeoutMs: typeof config.uiaTimeoutMs === 'number' && config.uiaTimeoutMs >= 1000 ? config.uiaTimeoutMs : 20000,
    powershellPath: typeof config.powershellPath === 'string' && config.powershellPath !== '' ? config.powershellPath : undefined,
    cdpPort: typeof config.cdpPort === 'number' && config.cdpPort >= 1 ? Math.round(config.cdpPort) : 9222,
    cdpTimeoutMs: typeof config.cdpTimeoutMs === 'number' && config.cdpTimeoutMs >= 500 ? Math.round(config.cdpTimeoutMs) : 10000,
    browserPath: typeof config.browserPath === 'string' && config.browserPath !== '' ? config.browserPath : undefined,
    provideSkill: config.provideSkill !== false,
  };
}

export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config);
  let worker = null;
  const cdpCache = new Map();
  const deps = {
    config: () => resolved,
    uia() {
      if (worker === null) worker = createUiaWorker({ powershellPath: resolved.powershellPath });
      return worker;
    },
    /** One cached CDP connection per (port, target) pair. */
    async cdp(port, target) {
      const key = port + '::' + target.id;
      const cached = cdpCache.get(key);
      if (cached !== undefined) return cached;
      const client = createCdpClient(target.wsUrl, { timeoutMs: resolved.cdpTimeoutMs });
      await client.send('Runtime.enable', {}, resolved.cdpTimeoutMs).catch(() => {});
      cdpCache.set(key, client);
      return client;
    },
    dropCdp(port) {
      for (const [key, client] of [...cdpCache.entries()]) {
        if (key.startsWith(port + '::')) {
          client.close();
          cdpCache.delete(key);
        }
      }
    },
  };
  registerTools(ctx, deps);
  registerBundledSkill(ctx, resolved.provideSkill !== false);
  // Activation marker: makes it obvious from outside whether the host really
  // mounted this plugin, and which build it loaded.
  try {
    const marker = { at: new Date().toISOString(), version: '0.1.0', pid: process.pid, captureDir: resolved.captureDir };
    void mkdir(resolved.captureDir, { recursive: true })
      .then(() => writeFile(join(resolved.captureDir, 'activation.json'), JSON.stringify(marker, null, 2)))
      .catch(() => {});
    if (ctx.logger && typeof ctx.logger.info === 'function') ctx.logger.info('dsh-win-control: tools registered');
  } catch {}
  ctx.effect(() => () => {
    if (worker !== null) worker.close();
    worker = null;
    for (const client of cdpCache.values()) client.close();
    cdpCache.clear();
  }, 'dsh-win-control: UI Automation worker + CDP connections');
}
