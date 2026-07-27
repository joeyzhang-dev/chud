const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hud', {
  getState: () => ipcRenderer.invoke('get-state'),
  focusSession: (key) => ipcRenderer.invoke('focus-session', key),
  openMirror: (key) => ipcRenderer.invoke('open-mirror', key),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (patch) => ipcRenderer.send('set-settings', patch),
  onSettings: (cb) => ipcRenderer.on('settings', (_e, s) => cb(s)),
  onHotkeyFocus: (cb) => ipcRenderer.on('hotkey-focus', () => cb()),
  onNavClear: (cb) => ipcRenderer.on('nav-clear', () => cb()),
  onKb: (cb) => ipcRenderer.on('kb', (_e, a) => cb(a)),
  returnFocus: () => ipcRenderer.send('return-focus'),
  suspendHotkey: () => ipcRenderer.send('suspend-hotkey'),
  resumeHotkey: () => ipcRenderer.send('resume-hotkey'),
  onState: (cb) => ipcRenderer.on('state', (_e, state) => cb(state)),
  openPort: (port) => ipcRenderer.send('open-port', port),
  refresh: () => ipcRenderer.invoke('refresh'),
  pickSoundDir: () => ipcRenderer.invoke('pick-sound-dir'),
  previewSound: (v) => ipcRenderer.send('preview-sound', v),
  listSounds: () => ipcRenderer.invoke('list-sounds'),
  previewFile: (n, v) => ipcRenderer.send('preview-file', n, v),
  close: () => ipcRenderer.send('close-window'),
});
