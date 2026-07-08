// Shim window.chrome.webview pour chrome.html et panel.html.
// contextIsolation est désactivé pour ces pages internes que l'on contrôle,
// afin d'installer directement l'objet dans le monde principal.

const { ipcRenderer } = require('electron');

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

if (!window.chrome) window.chrome = {};
try { Object.defineProperty(window.chrome, 'webview', { value: webview, configurable: true, writable: false }); }
catch { window.chrome.webview = webview; }
