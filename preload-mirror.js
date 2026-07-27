const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mirror', {
  onState: (cb) => ipcRenderer.on('mirror-state', (_e, s) => cb(s)),
  sendText: (uuid, text) => ipcRenderer.send('mirror-input', { uuid, text }),
  sendKey: (uuid, key) => ipcRenderer.send('mirror-key', { uuid, key }),
  close: (uuid) => ipcRenderer.send('mirror-close', { uuid }),
});
