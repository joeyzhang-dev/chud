const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { execFile } = require('child_process');

const CMUX_BIN = '/Applications/cmux.app/Contents/Resources/bin/cmux';

// Reading a screen over the control socket costs ~0.5ms, so the poll interval
// is now the entire latency budget rather than a rounding error on top of a
// 130ms process spawn. 100ms while you are looking at the window, 500ms when
// you are not — an unfocused mirror is a status light, not a terminal.
const POLL_FOCUSED_MS = 100;
const POLL_IDLE_MS = 500;
// Every send pulls the next read forward to here, so your own echo lands
// immediately instead of waiting out the rest of the current tick.
const ECHO_MS = 40;
// A call that never comes back would otherwise wedge the poll loop for good.
const CALL_TIMEOUT_MS = 3000;

const MAX_INPUT = 2000;
const WIDTH = 720;
const HEIGHT = 480;

// One mirror per cmux surface: uuid -> { win, timer, title, ... }
const mirrors = new Map();

// Same deal as collector.js: cmux's socket only trusts descendants of the cmux
// app unless a socket password is configured.
function cmuxPassword() {
  try {
    const cfg = fs.readFileSync(path.join(os.homedir(), '.config', 'cmux', 'cmux.json'), 'utf8');
    const m = cfg.match(/"socketPassword"\s*:\s*"([^"]+)"/);
    return m ? m[1] : null;
  } catch { return null; }
}

function cmuxEnv() {
  const env = { ...process.env, CMUX_QUIET: '1' };
  const pw = cmuxPassword();
  if (pw) env.CMUX_SOCKET_PASSWORD = pw;
  return env;
}

// A cmux surface UUID as `cmux tree` prints it.
function isSurfaceUuid(id) {
  return typeof id === 'string' && /^[0-9A-Fa-f-]{36}$/.test(id);
}

/* ---------------------------- cmux control socket ------------------------- */

// cmux's control socket speaks newline-delimited JSON: a bare `auth <password>`
// line first, then {id, method, params} out and {id, ok, result|error} back.
// Spawning the `cmux` CLI for the same work costs ~130ms per call — nearly all
// of it process startup — which is what made the old mirror feel like a fax.
// Everything here is a fallback away from that CLI, never a hard dependency.

let sock = null;
let sockReady = false;
let sockBuf = '';
let sockPath = null;
let sockPathAsked = false;
let reconnectTimer = null;
let reconnectDelay = 250;
let nextId = 1;
const pending = new Map();

function defaultSocketPath() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : '';
  return path.join(os.homedir(), '.local', 'state', 'cmux', `cmux-${uid}.sock`);
}

// `cmux capabilities` prints the socket it would itself use, which is the only
// thing that gets tagged/debug builds right. Asked once, lazily, and only if
// the conventional path is not already there.
function resolveSocketPath(cb) {
  if (sockPath) return cb(sockPath);
  const guess = defaultSocketPath();
  if (fs.existsSync(guess)) { sockPath = guess; return cb(sockPath); }
  if (sockPathAsked) return cb(null);
  sockPathAsked = true;
  execFile(CMUX_BIN, ['capabilities'], { timeout: 4000, env: cmuxEnv() }, (err, stdout) => {
    if (!err) {
      try {
        const p = JSON.parse(String(stdout)).socket_path;
        if (typeof p === 'string' && p) sockPath = p;
      } catch { /* fall through to the CLI path */ }
    }
    cb(sockPath);
  });
}

function failPending(err) {
  const waiting = [...pending.values()];
  pending.clear();
  for (const p of waiting) {
    clearTimeout(p.timer);
    p.cb(err || new Error('cmux socket closed'));
  }
}

function dropSocket() {
  sockReady = false;
  sockBuf = '';
  if (sock) {
    sock.removeAllListeners();
    sock.destroy();
    sock = null;
  }
  failPending(new Error('cmux socket closed'));
}

function scheduleReconnect() {
  if (reconnectTimer || !mirrors.size) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectSocket();
  }, reconnectDelay);
  // Back off to a slow retry if cmux is closed, so a shut app is not poked
  // four times a second for as long as a mirror sits open.
  reconnectDelay = Math.min(reconnectDelay * 2, 5000);
}

function handleLine(line) {
  if (!sockReady) {
    // The handshake reply is a bare `OK: Authenticated` / error line, not JSON.
    if (/^OK/i.test(line)) {
      sockReady = true;
      reconnectDelay = 250;
    } else {
      dropSocket();
      scheduleReconnect();
    }
    return;
  }
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  clearTimeout(p.timer);
  if (msg.ok) p.cb(null, msg.result);
  else p.cb(new Error((msg.error && msg.error.message) || 'cmux rpc failed'));
}

function connectSocket() {
  if (sock || !mirrors.size) return;
  const pw = cmuxPassword();
  if (!pw) return; // no password configured: the CLI fallback is all we have
  resolveSocketPath((p) => {
    if (!p || sock || !mirrors.size) return;
    let s;
    try { s = net.createConnection(p); } catch { scheduleReconnect(); return; }
    sock = s;
    s.setNoDelay(true);
    s.on('connect', () => { s.write('auth ' + pw + '\n'); });
    s.on('data', (chunk) => {
      sockBuf += chunk;
      let i;
      while ((i = sockBuf.indexOf('\n')) >= 0) {
        const line = sockBuf.slice(0, i);
        sockBuf = sockBuf.slice(i + 1);
        if (line) handleLine(line);
      }
    });
    const bail = () => {
      if (sock !== s) return;
      dropSocket();
      scheduleReconnect();
    };
    s.on('error', bail);
    s.on('close', bail);
  });
}

function closeSocketIfIdle() {
  if (mirrors.size) return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  dropSocket();
}

// Prefers the socket; falls back to `cmux rpc`, which accepts the same method
// names and prints the bare result object. A mirror on the slow path is the old
// mirror, which is still a working mirror.
function call(method, params, cb) {
  if (sockReady && sock) {
    const id = nextId++;
    const entry = {
      cb: cb || (() => {}),
      timer: setTimeout(() => {
        pending.delete(id);
        if (cb) cb(new Error('cmux rpc timeout'));
      }, CALL_TIMEOUT_MS),
    };
    pending.set(id, entry);
    try {
      sock.write(JSON.stringify({ id, method, params }) + '\n');
    } catch (err) {
      pending.delete(id);
      clearTimeout(entry.timer);
      if (cb) cb(err);
    }
    return;
  }
  connectSocket();
  execFile(CMUX_BIN, ['rpc', method, JSON.stringify(params)],
    { timeout: 5000, env: cmuxEnv() }, (err, stdout) => {
      if (!cb) return;
      if (err) return cb(err);
      try { cb(null, JSON.parse(String(stdout))); } catch (e) { cb(e); }
    });
}

/* ------------------------------ screen frames ----------------------------- */

// `terminal.replay` hands back cmux's own render grid: a style table with the
// Ghostty theme's colours already resolved to hex, plus spans of text tagged
// with a style id. No ANSI parsing, no palette guessing, and it carries
// scrollback and the cursor for free.

function styleKey(st) {
  return {
    fg: st.foreground || null,
    bg: st.background || null,
    b: !!st.bold,
    f: !!st.faint,
    i: !!st.italic,
    u: !!st.underline,
    s: !!st.strikethrough,
    o: !!st.overline,
    r: !!st.inverse,
    h: !!st.invisible,
  };
}

// Spans arrive unordered and only where something was drawn, so each row is
// rebuilt left to right with the gaps padded back out to spaces. `starts` keeps
// the terminal column each segment began at, which is what makes the cursor
// conversion below possible after the text has been flattened.
function packRow(spans) {
  spans.sort((a, b) => a.column - b.column);
  const segs = [];
  const starts = [];
  let col = 0;
  for (const sp of spans) {
    const text = typeof sp.text === 'string' ? sp.text : '';
    if (!text) continue;
    if (sp.column > col) {
      starts.push(col);
      segs.push([' '.repeat(sp.column - col), 0]);
      col = sp.column;
    } else if (sp.column < col) {
      continue; // overlapping span: first one wins
    }
    starts.push(col);
    segs.push([text, sp.style_id | 0]);
    col += sp.cell_width || text.length;
  }
  return { segs, starts, width: col };
}

// The renderer walks a row by JavaScript string length; cmux counts terminal
// cells, and a wide glyph is two cells for one character. Converting here, while
// cell_width is still around, is what keeps the cursor on the right character in
// a prompt containing emoji or powerline glyphs.
function charOffset(packed, targetCol) {
  const { segs, starts, width } = packed;
  let chars = 0;
  for (let i = 0; i < segs.length; i++) {
    const start = starts[i];
    if (targetCol <= start) return chars;
    const text = segs[i][0];
    const end = i + 1 < segs.length ? starts[i + 1] : width;
    if (targetCol < end) return chars + Math.min(targetCol - start, text.length);
    chars += text.length;
  }
  return chars + Math.max(0, targetCol - width);
}

function buildFrame(res) {
  const grid = (res && res.render_grid) || null;
  if (!grid) return null;

  const styles = {};
  for (const st of grid.styles || []) styles[st.id | 0] = styleKey(st);

  const sbRows = grid.scrollback_rows | 0;
  const vpRows = grid.rows | 0;
  const buckets = [];
  for (let i = 0; i < sbRows + vpRows; i++) buckets.push([]);

  for (const sp of grid.scrollback_spans || []) {
    const r = sp.row | 0;
    if (r >= 0 && r < sbRows) buckets[r].push(sp);
  }
  for (const sp of grid.row_spans || []) {
    const r = (sp.row | 0) + sbRows;
    if (r >= sbRows && r < buckets.length) buckets[r].push(sp);
  }

  const packed = buckets.map(packRow);
  // cmux pads rows out to the terminal width. Those trailing spaces draw
  // nothing but they widen the grid, which would cost a font size step and hang
  // a scrollbar on empty air. Interior blanks are part of what the TUI drew and
  // stay; only the dead rows below the last line of content are dropped.
  for (const p of packed) {
    // starts[n] is where the first dropped segment began, i.e. the new width.
    while (p.segs.length && !p.segs[p.segs.length - 1][0].trim()) {
      p.segs.pop();
      p.width = p.starts[p.segs.length];
    }
    // The padding usually rides along inside the last real span rather than in
    // a span of its own, so dropping blank segments alone leaves it behind.
    // It is always spaces, one cell each, so the width falls by the same count.
    if (p.segs.length) {
      const seg = p.segs[p.segs.length - 1];
      const trimmed = seg[0].replace(/[ \t\r]+$/, '');
      if (trimmed !== seg[0]) {
        p.width -= seg[0].length - trimmed.length;
        seg[0] = trimmed;
      }
    }
  }

  const cur = grid.cursor;
  const hasCursor = !!cur && cur.visible !== false;
  const cursorRow = hasCursor ? sbRows + (cur.row | 0) : -1;
  let last = packed.length;
  while (last > 0 && !packed[last - 1].segs.length && last - 1 > cursorRow) last--;
  packed.length = last;

  let cols = 0;
  for (const p of packed) cols = Math.max(cols, p.width);

  const base = styles[0] || {};
  return {
    rows: packed.map((p) => p.segs),
    styles,
    cols,
    bg: base.bg || null,
    fg: base.fg || null,
    cursor: hasCursor && cursorRow >= 0 && cursorRow < packed.length
      ? { row: cursorRow, col: charOffset(packed[cursorRow], cur.column | 0) }
      : null,
  };
}

/* -------------------------------- lifecycle ------------------------------- */

function openMirror({ uuid, workspaceUuid, title } = {}) {
  if (!isSurfaceUuid(uuid)) return null;

  const existing = mirrors.get(uuid);
  if (existing && existing.win && !existing.win.isDestroyed()) {
    if (existing.win.isMinimized()) existing.win.restore();
    existing.win.show();
    existing.win.focus();
    return existing.win;
  }

  // Center on whichever display the cursor is on — the mirror is opened from a
  // click, so that is the display the user is looking at.
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const win = new BrowserWindow({
    x: Math.round(wa.x + (wa.width - WIDTH) / 2),
    y: Math.round(wa.y + (wa.height - HEIGHT) / 2),
    width: WIDTH,
    height: HEIGHT,
    minWidth: 400,
    minHeight: 300,
    frame: false,
    transparent: true,
    hasShadow: true,
    resizable: true,
    // Unlike the HUD itself, the mirror is a working surface — pinning it over
    // everything while typing into it would be in the way.
    alwaysOnTop: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-mirror.js'),
    },
  });

  const entry = {
    win,
    workspaceUuid: workspaceUuid || null,
    title: title || '',
    timer: null,
    lastFrame: null,
    reading: false,
    errorSent: false,
    focused: true,
    visible: true,
  };
  mirrors.set(uuid, entry);
  connectSocket();

  // Polling starts only once the page is up: we push on change, so a frame sent
  // into a renderer that has not loaded yet would leave the window blank until
  // the terminal happened to change.
  win.webContents.on('did-finish-load', () => {
    entry.lastFrame = null;      // a reload must get the full screen again
    entry.errorSent = false;
    tick(uuid);
  });

  // Cadence follows attention. Each of these reschedules immediately so the
  // change takes effect on the next read rather than after the current wait.
  const wake = (focused) => () => {
    entry.focused = focused;
    entry.visible = !win.isDestroyed() && win.isVisible() && !win.isMinimized();
    schedule(uuid, focused ? ECHO_MS : POLL_IDLE_MS);
  };
  win.on('focus', wake(true));
  win.on('blur', wake(false));
  win.on('show', wake(true));
  win.on('restore', wake(true));
  win.on('hide', wake(false));
  win.on('minimize', wake(false));

  win.on('closed', () => {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    mirrors.delete(uuid);
    closeSocketIfIdle();
  });

  win.loadFile(path.join(__dirname, 'renderer', 'mirror.html'), {
    search: `uuid=${uuid}&title=${encodeURIComponent(title || '')}`,
  });
  return win;
}

function pollDelay(entry) {
  if (!entry.visible) return POLL_IDLE_MS;
  return entry.focused ? POLL_FOCUSED_MS : POLL_IDLE_MS;
}

function schedule(uuid, ms) {
  const entry = mirrors.get(uuid);
  if (!entry || !entry.win || entry.win.isDestroyed()) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => tick(uuid), ms);
}

// Self-rescheduling rather than an interval: the cadence changes with focus,
// and a read can never stack on top of one still in flight.
function tick(uuid) {
  const entry = mirrors.get(uuid);
  if (!entry || !entry.win || entry.win.isDestroyed()) return;
  if (entry.reading) { schedule(uuid, ECHO_MS); return; }
  entry.reading = true;

  call('terminal.replay', { surface_id: uuid }, (err, res) => {
    entry.reading = false;
    const win = entry.win;
    if (!win || win.isDestroyed()) return;
    schedule(uuid, pollDelay(entry));

    let frame = null;
    if (!err) { try { frame = buildFrame(res); } catch { frame = null; } }

    if (!frame) {
      // Say "unreachable" once per outage, not ten times a second.
      if (!entry.errorSent) {
        entry.errorSent = true;
        entry.lastFrame = null;
        win.webContents.send('mirror-state', { title: entry.title, frame: null, error: 'unreachable' });
      }
      return;
    }
    entry.errorSent = false;
    const serialized = JSON.stringify(frame);
    if (serialized === entry.lastFrame) return;
    entry.lastFrame = serialized;
    win.webContents.send('mirror-state', { title: entry.title, frame });
  });
}

function closeMirror(uuid) {
  const entry = mirrors.get(uuid);
  if (entry && entry.win && !entry.win.isDestroyed()) entry.win.close();
}

/* ---------------------------------- input --------------------------------- */

// Every name here was tried against a live zsh and watched, because "accepted"
// and "does the right thing" are different questions for this API. The ones
// that are absent are absent on purpose:
//   pageup/pagedown  typed a literal `~` into the prompt
//   shift+<arrow>    typed a literal `;2D`
//   alt+<letter>     silently did nothing (so alt+b/alt+f are NOT word motion —
//                    alt+left / alt+right are)
//   home/end         silently did nothing (the renderer sends ctrl+a / ctrl+e)
const KEY_MAP = {
  enter: 'enter',
  backspace: 'backspace',
  tab: 'tab',
  escape: 'escape',
  space: 'space',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  delete: 'delete',
  'alt+left': 'alt+left',
  'alt+right': 'alt+right',
};
// ctrl+<letter> is uniformly safe: every one of a-z was checked for stray
// output and they all land as the readline binding you would expect.
for (const c of 'abcdefghijklmnopqrstuvwxyz') KEY_MAP['ctrl+' + c] = 'ctrl+' + c;

// Registered at module load. The guard is for a double `require` (different
// resolved paths, or a dev reload) — a second registration would send every
// keystroke to cmux twice.
function registerIpc() {
  if (ipcMain.listenerCount('mirror-input')) return;

  ipcMain.on('mirror-input', (_e, msg) => {
    const { uuid, text } = msg || {};
    if (!isSurfaceUuid(uuid)) return;
    if (typeof text !== 'string' || !text.length || text.length > MAX_INPUT) return;
    // Unlike `cmux send`, surface.send_text does no escape expansion, so a typed
    // backslash-n stays a backslash-n. Enter and Tab are keys, not text.
    call('surface.send_text', { surface_id: uuid, text });
    schedule(uuid, ECHO_MS);
  });

  ipcMain.on('mirror-key', (_e, msg) => {
    const { uuid, key } = msg || {};
    if (!isSurfaceUuid(uuid)) return;
    if (typeof key !== 'string') return;
    const name = KEY_MAP[key.toLowerCase()];
    if (!name) return; // unmapped keys are dropped, never guessed
    call('surface.send_key', { surface_id: uuid, key: name });
    schedule(uuid, ECHO_MS);
  });

  // The renderer reports its own visibility too, so a window that is on another
  // Space or fully covered drops to the slow cadence even without a blur.
  ipcMain.on('mirror-active', (_e, msg) => {
    const { uuid, active } = msg || {};
    if (!isSurfaceUuid(uuid)) return;
    const entry = mirrors.get(uuid);
    if (!entry) return;
    entry.visible = !!active;
    schedule(uuid, active ? ECHO_MS : POLL_IDLE_MS);
  });

  ipcMain.on('mirror-close', (_e, msg) => {
    const uuid = typeof msg === 'string' ? msg : (msg && msg.uuid);
    if (isSurfaceUuid(uuid)) closeMirror(uuid);
  });
}

registerIpc();

module.exports = { openMirror };
