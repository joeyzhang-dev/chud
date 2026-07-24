const { app, BrowserWindow, ipcMain, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { Collector } = require('./collector');

let win;
let collector;

const DEFAULT_SETTINGS = { focusedOpacity: 1, unfocusedOpacity: 0.85, compact: false, hotkey: 'Control+Shift+Space' };
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

function registerHotkey(accelerator) {
  globalShortcut.unregisterAll();
  if (!accelerator) return true;
  try {
    return globalShortcut.register(accelerator, onHotkey);
  } catch {
    return false;
  }
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
  const prevHotkey = settings.hotkey;
  settings = { ...settings, ...patch };
  delete settings.hotkeyError;
  if ('hotkey' in patch && patch.hotkey !== prevHotkey) {
    if (!registerHotkey(settings.hotkey)) {
      settings.hotkey = prevHotkey;
      settings.hotkeyError = `Could not register "${patch.hotkey}"`;
      registerHotkey(prevHotkey);
    }
  }
  saveSettings();
  applySettings();
}

function createWindow() {
  win = new BrowserWindow({
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
  loadSettings();
  createWindow();

  collector = new Collector((state) => {
    if (win && !win.isDestroyed()) win.webContents.send('state', state);
  });
  collector.onScreenshot = async (file) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(file, img.toPNG());
  };
  collector.start();

  collector.onSettingsDebug = (patch) => updateSettings(patch);

  ipcMain.handle('get-state', () => collector.getState());
  ipcMain.handle('focus-session', (_e, key) => collector.focusSession(key));
  ipcMain.handle('get-settings', () => settings);
  ipcMain.on('set-settings', (_e, patch) => updateSettings(patch));
  ipcMain.on('return-focus', () => returnFocus());
  ipcMain.on('suspend-hotkey', () => globalShortcut.unregisterAll());
  ipcMain.on('resume-hotkey', () => registerHotkey(settings.hotkey));
  ipcMain.on('close-window', () => win.close());

  if (!registerHotkey(settings.hotkey)) {
    settings.hotkeyError = `Could not register "${settings.hotkey}" (in use by another app?)`;
  }
});

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', () => {
  app.quit();
});
