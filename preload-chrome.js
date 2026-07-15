// Pont window.zaalisBridge pour les pages internes. Même ces pages restent
// isolées : aucune API Node/Electron ne fuit dans le monde de la page.

const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Set();

ipcRenderer.on('zaalis:message', (_e, data) => {
  const evt = { data };
  for (const cb of listeners) { try { cb(evt); } catch (err) { console.error(err); } }
});

const webview = {
  postMessage(msg) {
    if (typeof msg !== 'string') { try { msg = JSON.stringify(msg); } catch { return; } }
    ipcRenderer.send('zaalis:postMessage', msg);
  },
  addEventListener(name, cb) {
    if (name === 'message' && typeof cb === 'function') listeners.add(cb);
  },
  removeEventListener(name, cb) {
    if (name === 'message') listeners.delete(cb);
  },
};

contextBridge.exposeInMainWorld('zaalisBridge', webview);
