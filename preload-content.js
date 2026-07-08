// Preload injecté dans chaque onglet de contenu.
// Ne fournit `window.chrome.webview` que pour les pages internes zaalis://home/*
// (la page d'accueil s'en sert pour piloter les raccourcis et la recherche).
// Sur les sites externes, l'objet est également présent mais inoffensif : il
// se contente d'envoyer un message IPC que le main peut ignorer.

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
