const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { Collector } = require('./collector');

let win;
let collector;

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
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();

  collector = new Collector((state) => {
    if (win && !win.isDestroyed()) win.webContents.send('state', state);
  });
  collector.onScreenshot = async (file) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(file, img.toPNG());
  };
  collector.start();

  ipcMain.handle('get-state', () => collector.getState());
  ipcMain.on('close-window', () => win.close());
});

app.on('window-all-closed', () => {
  app.quit();
});
