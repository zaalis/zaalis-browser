// Preload injecté dans chaque onglet de contenu.
// Ne fournit `window.zaalisBridge` que pour les pages internes zaalis://home/*
// (la page d'accueil s'en sert pour piloter les raccourcis et la recherche).
// Il ne faut surtout pas l'exposer aux sites externes : certains, dont YouTube,
// détectent cette API comme un environnement WebView et adaptent leur routage ou
// leur comportement d'autoplay.

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

if (location.protocol === 'zaalis:') {
  // Le pont n'est publié que pour les pages de l'application. Les sites
  // externes ne voient ni API Electron, ni objet ajouté par le navigateur.
  contextBridge.exposeInMainWorld('zaalisBridge', webview);
}
