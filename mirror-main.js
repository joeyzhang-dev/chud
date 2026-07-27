const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const CMUX_BIN = '/Applications/cmux.app/Contents/Resources/bin/cmux';
const POLL_MS = 400;
const SCREEN_LINES = '200';
const MAX_INPUT = 2000;
const WIDTH = 720;
const HEIGHT = 480;

// One mirror per cmux surface: uuid -> { win, timer, title, workspaceUuid, ... }
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

// DOM key names (KeyboardEvent.key) -> the names cmux's send-key parser takes.
// Verified against a live surface: unknown names come back as
// "invalid_params: Unknown key", so anything not listed here is dropped rather
// than guessed at.
const KEY_MAP = {
  enter: 'enter',
  backspace: 'backspace',
  tab: 'tab',
  escape: 'escape',
  esc: 'escape',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  ' ': 'space',
  space: 'space',
  spacebar: 'space',
  'ctrl+c': 'ctrl+c',
  'ctrl+u': 'ctrl+u',
  'ctrl+d': 'ctrl+d',
  'ctrl+r': 'ctrl+r',
  'ctrl+l': 'ctrl+l',
};

function cmux(args, cb) {
  execFile(CMUX_BIN, args, { timeout: 4000, env: cmuxEnv() }, (err, stdout) => {
    if (cb) cb(err, stdout);
  });
}

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
    lastText: null,
    reading: false,
    errorSent: false,
  };
  mirrors.set(uuid, entry);

  // Polling starts only once the page is up: the first screen read is usually
  // the only one that ever fires (we push on change), so sending it into a
  // renderer that has not loaded yet would leave the window blank until the
  // terminal happened to change.
  win.webContents.on('did-finish-load', () => {
    entry.lastText = null;      // a reload must get the full screen again
    entry.errorSent = false;
    if (entry.timer) clearInterval(entry.timer);
    entry.timer = setInterval(() => pollScreen(uuid), POLL_MS);
    pollScreen(uuid);
  });

  win.on('closed', () => {
    if (entry.timer) clearInterval(entry.timer);
    entry.timer = null;
    mirrors.delete(uuid);
  });

  win.loadFile(path.join(__dirname, 'renderer', 'mirror.html'), {
    search: `uuid=${uuid}&title=${encodeURIComponent(title || '')}`,
  });
  return win;
}

function pollScreen(uuid) {
  const entry = mirrors.get(uuid);
  if (!entry || !entry.win || entry.win.isDestroyed()) return;
  // read-screen can take up to its 4s timeout; without this the 400ms tick
  // would stack ten overlapping reads against one surface.
  if (entry.reading) return;
  entry.reading = true;

  cmux(['read-screen', '--surface', uuid, '--lines', SCREEN_LINES], (err, stdout) => {
    entry.reading = false;
    const win = entry.win;
    if (!win || win.isDestroyed()) return;

    if (err) {
      // Say "unreachable" once per outage, not forty times a minute.
      if (!entry.errorSent) {
        entry.errorSent = true;
        entry.lastText = null;
        win.webContents.send('mirror-state', { title: entry.title, text: null, error: 'unreachable' });
      }
      return;
    }
    entry.errorSent = false;
    const text = String(stdout);
    if (text === entry.lastText) return;
    entry.lastText = text;
    win.webContents.send('mirror-state', { title: entry.title, text });
  });
}

function closeMirror(uuid) {
  const entry = mirrors.get(uuid);
  if (entry && entry.win && !entry.win.isDestroyed()) entry.win.close();
}

// Registered at module load. The guard is for a double `require` (different
// resolved paths, or a dev reload) — a second registration would send every
// keystroke to cmux twice.
function registerIpc() {
  if (ipcMain.listenerCount('mirror-input')) return;

  ipcMain.on('mirror-input', (_e, msg) => {
    const { uuid, text } = msg || {};
    if (!isSurfaceUuid(uuid)) return;
    if (typeof text !== 'string' || !text.length || text.length > MAX_INPUT) return;
    // NOTE: `cmux send` expands \n, \r and \t itself, so newlines belong in
    // 'mirror-key' (enter/tab) rather than in this text.
    cmux(['send', '--surface', uuid, text]);
  });

  ipcMain.on('mirror-key', (_e, msg) => {
    const { uuid, key } = msg || {};
    if (!isSurfaceUuid(uuid)) return;
    if (typeof key !== 'string') return;
    const name = KEY_MAP[key.toLowerCase()];
    if (!name) return; // unmapped keys are dropped, never guessed
    cmux(['send-key', '--surface', uuid, name]);
  });

  ipcMain.on('mirror-close', (_e, msg) => {
    const uuid = typeof msg === 'string' ? msg : (msg && msg.uuid);
    if (isSurfaceUuid(uuid)) closeMirror(uuid);
  });
}

registerIpc();

module.exports = { openMirror };
