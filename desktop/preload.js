const { contextBridge, ipcRenderer } = require('electron');

// Minimal, explicit surface exposed to the web app.
contextBridge.exposeInMainWorld('devboard', {
  onAuth(cb) {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('auth', handler);
    return () => ipcRenderer.removeListener('auth', handler);
  },
});
