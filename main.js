const { app, BrowserWindow, ipcMain, globalShortcut, screen, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { Collector } = require('./collector');

let win;
let collector;

const DEFAULT_SETTINGS = { focusedOpacity: 1, unfocusedOpacity: 0.85, compact: false, hotkey: 'Control+Shift+Space', toggleHotkey: 'Control+Shift+H', followDisplay: true, doneSound: true, doneSoundDir: '/Users/joey/Downloads/claude sfx', doneSoundVolume: 1 };

// Random sound from the configured folder when any session finishes a turn.
// Lives here (not in per-agent hooks) so Copilot sessions get it too.
let lastSoundAt = 0;
function playDoneSound() {
  if (!settings.doneSound || !settings.doneSoundDir) return;
  if (Date.now() - lastSoundAt < 2000) return; // several finishes at once = one sound
  const pick = pickRandomSound();
  if (!pick) return;
  lastSoundAt = Date.now();
  execFile('afplay', ['-v', String((settings.doneSoundVolume ?? 1) * pick.vol), pick.file], () => {});
}

function pickRandomSound() {
  try {
    const cfg = settings.soundConfig || {};
    const files = fs.readdirSync(settings.doneSoundDir)
      .filter((x) => /\.(mp3|wav|m4a|aiff|ogg)$/i.test(x))
      .filter((x) => cfg[x]?.enabled !== false);
    if (!files.length) return null;
    const n = files[Math.floor(Math.random() * files.length)];
    return { file: path.join(settings.doneSoundDir, n), vol: cfg[n]?.volume ?? 1 };
  } catch { return null; }
}

// Slider preview: replay at the new volume, killing the previous preview so
// dragging doesn't stack overlapping sounds.
let previewChild = null;
function previewSound(vol) {
  const pick = pickRandomSound();
  if (!pick) return;
  playPreview(pick.file, vol * pick.vol);
}

function playPreview(file, vol) {
  if (previewChild) { try { previewChild.kill(); } catch { /* gone */ } }
  previewChild = execFile('afplay', ['-v', String(Math.min(1, Math.max(0, vol))), file], () => { previewChild = null; });
}

// Hop to whichever display the cursor is on, keeping the window's relative
// position. Skipped while the HUD is focused so it never fights the user.
function followDisplayTick() {
  if (!settings.followDisplay) return;
  if (!win || win.isDestroyed() || win.isFocused()) return;
  const cursor = screen.getCursorScreenPoint();
  const target = screen.getDisplayNearestPoint(cursor);
  const current = screen.getDisplayMatching(win.getBounds());
  if (!target || !current || target.id === current.id) return;
  const b = win.getBounds();
  const cw = current.workArea;
  const tw = target.workArea;
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const fx = clamp01((b.x - cw.x) / Math.max(1, cw.width - b.width));
  const fy = clamp01((b.y - cw.y) / Math.max(1, cw.height - b.height));
  win.setBounds({
    x: Math.round(tw.x + fx * Math.max(0, tw.width - b.width)),
    y: Math.round(tw.y + fy * Math.max(0, tw.height - b.height)),
    width: b.width,
    height: b.height,
  });
}
let prevAppBundle = null;

function frontmostBundle() {
  return new Promise((resolve) => {
    execFile('osascript', ['-e',
      'tell application "System Events" to get bundle identifier of first application process whose frontmost is true',
    ], { timeout: 2000 }, (err, out) => resolve(err ? null : out.trim()));
  });
}

async function onHotkey() {
  if (!win || win.isDestroyed()) return;
  if (win.isFocused()) { returnFocus(); return; }
  prevAppBundle = await frontmostBundle();
  app.focus({ steal: true });
  win.show();
  win.focus();
  win.webContents.send('hotkey-focus');
}

function returnFocus() {
  if (prevAppBundle && prevAppBundle !== 'com.github.Electron') {
    execFile('open', ['-b', prevAppBundle], () => {});
  }
  if (win && !win.isDestroyed()) win.webContents.send('nav-clear');
}

// Hide/show without stealing focus, so peeking at what's underneath
// doesn't interrupt whatever the user is typing elsewhere.
function onToggleHotkey() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) win.hide();
  else win.showInactive();
}

function tryRegister(accelerator, fn) {
  if (!accelerator) return true;
  try {
    return globalShortcut.register(accelerator, fn);
  } catch {
    return false;
  }
}

function registerHotkeys() {
  globalShortcut.unregisterAll();
  return {
    okFocus: tryRegister(settings.hotkey, onHotkey),
    okToggle: tryRegister(settings.toggleHotkey, onToggleHotkey),
  };
}
let settings = { ...DEFAULT_SETTINGS };
let settingsFile;

function loadSettings() {
  try { settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; } catch { /* first run */ }
}

function saveSettings() {
  try { fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2)); } catch { /* ignore */ }
}

function applySettings() {
  if (!win || win.isDestroyed()) return;
  win.setOpacity(win.isFocused() ? settings.focusedOpacity : settings.unfocusedOpacity);
  win.webContents.send('settings', settings);
}

function updateSettings(patch) {
  const prev = { hotkey: settings.hotkey, toggleHotkey: settings.toggleHotkey };
  settings = { ...settings, ...patch };
  delete settings.hotkeyError;
  if ('hotkey' in patch || 'toggleHotkey' in patch) {
    const r = registerHotkeys();
    if (!r.okFocus) {
      settings.hotkey = prev.hotkey;
      settings.hotkeyError = `Could not register "${patch.hotkey}"`;
    }
    if (!r.okToggle) {
      settings.toggleHotkey = prev.toggleHotkey;
      settings.hotkeyError = `Could not register "${patch.toggleHotkey}"`;
    }
    if (!r.okFocus || !r.okToggle) registerHotkeys();
  }
  saveSettings();
  applySettings();
}

function createWindow() {
  // Start at the top-right of whichever display the cursor is on — restarts
  // (frequent while iterating on the HUD) kept dropping it in screen center.
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  win = new BrowserWindow({
    x: wa.x + wa.width - 360 - 12,
    y: wa.y + 12,
    width: 360,
    height: 540,
    minWidth: 280,
    minHeight: 200,
    frame: false,
    transparent: true,
    hasShadow: true,
    resizable: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.on('focus', () => win.setOpacity(settings.focusedOpacity));
  win.on('blur', () => win.setOpacity(settings.unfocusedOpacity));
  win.webContents.on('did-finish-load', () => applySettings());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  settingsFile = path.join(app.getPath('userData'), 'hud-settings.json');
  // Migrate settings from the pre-rename "session-hud" userData dir
  if (!fs.existsSync(settingsFile)) {
    const legacy = path.join(app.getPath('userData'), '..', 'session-hud', 'hud-settings.json');
    try {
      if (fs.existsSync(legacy)) {
        fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
        fs.copyFileSync(legacy, settingsFile);
      }
    } catch { /* fresh start */ }
  }
  loadSettings();
  createWindow();
  setInterval(followDisplayTick, 250);

  collector = new Collector((state) => {
    if (win && !win.isDestroyed()) win.webContents.send('state', state);
  });
  collector.onScreenshot = async (file) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(file, img.toPNG());
  };
  collector.start();

  collector.onSettingsDebug = (patch) => updateSettings(patch);
  collector.onFinished = () => playDoneSound();

  ipcMain.handle('get-state', () => collector.getState());
  ipcMain.handle('focus-session', (_e, key) => collector.focusSession(key));
  ipcMain.handle('refresh', () => collector.refreshAll());
  ipcMain.on('preview-sound', (_e, v) => {
    const vol = Math.min(1, Math.max(0, Number(v) || 0));
    previewSound(vol);
  });
  ipcMain.handle('list-sounds', () => {
    let files = [];
    try {
      files = fs.readdirSync(settings.doneSoundDir).filter((x) => /\.(mp3|wav|m4a|aiff|ogg)$/i.test(x)).sort();
    } catch { /* folder missing */ }
    const cfg = settings.soundConfig || {};
    return files.map((n) => ({ name: n, enabled: cfg[n]?.enabled !== false, volume: cfg[n]?.volume ?? 1 }));
  });
  ipcMain.on('preview-file', (_e, name, vol) => {
    if (typeof name !== 'string' || name.includes('/') || name.includes('..')) return;
    playPreview(require('path').join(settings.doneSoundDir, name), Number(vol) || 0);
  });
  ipcMain.handle('pick-sound-dir', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose sound folder',
      defaultPath: settings.doneSoundDir || app.getPath('downloads'),
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return settings.doneSoundDir;
    updateSettings({ doneSoundDir: r.filePaths[0] });
    return r.filePaths[0];
  });
  ipcMain.handle('get-settings', () => settings);
  ipcMain.on('set-settings', (_e, patch) => updateSettings(patch));
  ipcMain.on('return-focus', () => returnFocus());
  ipcMain.on('suspend-hotkey', () => globalShortcut.unregisterAll());
  ipcMain.on('resume-hotkey', () => registerHotkeys());
  ipcMain.on('close-window', () => win.close());
  ipcMain.on('open-port', (_e, port) => {
    const n = Number(port);
    if (Number.isInteger(n) && n > 0 && n < 65536) shell.openExternal(`http://localhost:${n}`);
  });

  const r = registerHotkeys();
  if (!r.okFocus || !r.okToggle) {
    const bad = !r.okFocus ? settings.hotkey : settings.toggleHotkey;
    settings.hotkeyError = `Could not register "${bad}" (in use by another app?)`;
  }
});

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', () => {
  app.quit();
});
