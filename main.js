const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { Collector } = require('./collector');

let win;
let collector;

const DEFAULT_SETTINGS = { focusedOpacity: 1, unfocusedOpacity: 0.85, compact: false };
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
  settings = { ...settings, ...patch };
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
  ipcMain.on('close-window', () => win.close());
});

app.on('window-all-closed', () => {
  app.quit();
});
