/* =============================================================================
 *  zaalis browser — port macOS (Electron)
 * -----------------------------------------------------------------------------
 *  Reproduit le comportement du navigateur natif Windows :
 *   - Fenêtre unique avec chrome custom (chrome.html) en haut, contenu par onglet
 *     en dessous (WebContentsView par onglet, seul l'actif visible).
 *   - Page d'accueil zaalis (index.html) via protocole zaalis://.
 *   - Panneau latéral droit (panel.html) pour paramètres / historique.
 *   - Favoris, historique, raccourcis, réglages persistés dans
 *     ~/Library/Application Support/zaalis browser/.
 *   - API locale HTTP sur 127.0.0.1:8715 (search / open / newtab).
 *   - Bus de messages entre chrome/panel et le main via IPC, compatible avec
 *     le protocole 'action\x1farg' des pages HTML d'origine.
 * =========================================================================== */

'use strict';

const {
  app, BaseWindow, WebContentsView, ipcMain, Menu, shell,
  protocol, net, session, nativeImage, dialog
} = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const http = require('http');
const url  = require('url');

// ----- Constantes ------------------------------------------------------------

const HOME_URL   = 'zaalis://home/index.html';
const CHROME_URL = 'zaalis://home/chrome.html';
const PANEL_URL  = 'zaalis://home/panel.html';
const SEP        = '\x1f';
const API_PORT   = 8715;
const PANEL_WIDTH = 340;

// ----- État global -----------------------------------------------------------

let mainWin        = null;
let chromeView     = null;
let panelView      = null;
let dataFolder     = null;

const tabs   = [];              // { id, view, loading }
let   active = -1;
let   nextId = 1;
let   splitPair = null;         // [idGauche, idDroite] — vue fractionnee (2 max)

let chromeHeight = 128;
let contentTop   = 128;
let chromeOverlay = false;
let chromeOverlayRect = { left:0, top:0, right:0, bottom:0 };

let panelOpen = false;
let pendingPanelHistory = false;
let panelProgress = 0;      // 0 = fermé, 1 = ouvert
let panelAnimFrom = 0;
let panelAnimTo   = 0;
let panelAnimStart = 0;
let panelAnimTimer = null;
const PANEL_ANIM_MS = 190;

const settings = {
  theme:          'light',
  offline:        false,
  searchEngine:   'google',
  showBookmarks:  true,
  historyEnabled: true,
  blockPopups:    false,
  contextMenus:   true,
  devTools:       true,
  statusBar:      true,
  zoomControls:   true,
  safeSearch:     false,
  zoomPct:        100,
  aiProvider:     'codex',
  aiSubmodel:     'gpt-5.5',
  aiOverview:     true,
  aiConnectEnabled: true,
};

// Providers + sous-modeles disponibles pour la recherche/chat IA.
// Miroir du catalogue de zaalis labs ide (interface/script/state.js) : le
// navigateur envoie { model: provider, submodel } au serveur IDE local.
const AI_PROVIDERS = {
  codex:  { label: 'ChatGPT (OpenAI)',   submodels: ['gpt-5.5','gpt-5.4','gpt-5.1-codex','gpt-5.1','gpt-4.5','o3-mini','o1','gpt-4o-mini','gpt-3.5-turbo','gpt-4'] },
  claude: { label: 'Claude (Anthropic)', submodels: ['claude-fable-5','claude-opus-4-8','claude-sonnet-4-6','claude-haiku-4-5','claude-3-7-sonnet','claude-3-5-sonnet','claude-3-5-haiku'] },
  gemini: { label: 'Gemini (Google)',    submodels: ['gemini-3.5-flash','gemini-3.1-pro','gemini-3-flash','gemini-2.5-pro','gemini-2.5-flash'] },
  grok:   { label: 'Grok (xAI)',         submodels: ['grok-4.3','grok-4.20-multi-agent-0309','grok-4.20-0309-reasoning','grok-4.20-0309-non-reasoning','grok-build-0.1'] },
  mistral:{ label: 'Mistral',            submodels: ['mistral-large-latest','mistral-medium-latest','mistral-small-latest','codestral-latest','pixtral-large-latest'] },
  local:  { label: 'Local (Ollama)',     submodels: ['qwen3:8b','llama3.2','gemma3:4b','deepseek-r1:8b','qwen2.5-coder:7b'] },
};
const AI_MODEL_LABELS = {
  'gpt-5.5': 'GPT-5.5', 'gpt-5.4': 'GPT-5.4', 'gpt-5.1-codex': 'GPT-5.1 Codex', 'gpt-5.1': 'GPT-5.1',
  'gpt-4.5': 'GPT-4.5', 'o3-mini': 'o3-mini', 'o1': 'o1', 'gpt-4o-mini': 'GPT-4o mini',
  'gpt-3.5-turbo': 'GPT-3.5 Turbo', 'gpt-4': 'GPT-4',
  'claude-fable-5': 'Claude Fable 5', 'claude-opus-4-8': 'Claude Opus 4.8', 'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'claude-haiku-4-5': 'Claude Haiku 4.5', 'claude-3-7-sonnet': 'Claude Sonnet 3.7',
  'claude-3-5-sonnet': 'Claude Sonnet 3.5', 'claude-3-5-haiku': 'Claude Haiku 3.5',
  'gemini-3.5-flash': 'Gemini 3.5 Flash', 'gemini-3.1-pro': 'Gemini 3.1 Pro', 'gemini-3-flash': 'Gemini 3 Flash',
  'gemini-2.5-pro': 'Gemini 2.5 Pro', 'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'grok-4.3': 'Grok 4.3', 'grok-4.20-multi-agent-0309': 'Grok 4.20 Multi-Agent',
  'grok-4.20-0309-reasoning': 'Grok 4.20 Reasoning', 'grok-4.20-0309-non-reasoning': 'Grok 4.20 Non-Reasoning',
  'grok-build-0.1': 'Grok Build 0.1',
  'mistral-large-latest': 'Mistral Large', 'mistral-medium-latest': 'Mistral Medium',
  'mistral-small-latest': 'Mistral Small', 'codestral-latest': 'Codestral', 'pixtral-large-latest': 'Pixtral Large',
};
function aiModelLabel() {
  return AI_MODEL_LABELS[settings.aiSubmodel] || settings.aiSubmodel ||
         (AI_PROVIDERS[settings.aiProvider] || {}).label || 'IA';
}
function validAiChoice(provider, submodel) {
  const p = AI_PROVIDERS[provider];
  if (!p) return false;
  // 'local' accepte n'importe quel tag Ollama installe (liste ouverte).
  return provider === 'local' ? !!submodel : p.submodels.includes(submodel);
}

let bookmarks = [];   // { url, title }
let shortcuts = [];   // { url, title } — home page tiles
let history   = [];   // { url, title }

// ----- Lanceur d'applications (facon Google) --------------------------------
// Deux modes par profil : « travail » = grille preremplie d'apps Google (icones
// via favicon, non modifiable) ; « creatif » = raccourcis ajoutes/supprimes par
// l'utilisateur. Persiste par profil dans launcher.json.
const WORK_APPS = [
  { url: 'https://myaccount.google.com', title: 'Compte' },
  { url: 'https://drive.google.com',     title: 'Drive' },
  { url: 'https://mail.google.com',      title: 'Gmail' },
  { url: 'https://www.youtube.com',      title: 'YouTube' },
  { url: 'https://gemini.google.com',    title: 'Gemini' },
  { url: 'https://maps.google.com',      title: 'Maps' },
  { url: 'https://www.google.com',       title: 'Recherche' },
  { url: 'https://calendar.google.com',  title: 'Agenda' },
  { url: 'https://news.google.com',      title: 'Actualités' },
  { url: 'https://photos.google.com',    title: 'Photos' },
  { url: 'https://meet.google.com',      title: 'Meet' },
  { url: 'https://translate.google.com', title: 'Traduction' },
  { url: 'https://docs.google.com',      title: 'Docs' },
];
let launcherMode = 'travail';   // 'travail' | 'creatif'
let launcherApps = [];          // mode creatif : { url, title }

// Mode recherche IA (zaalis labs ide) : etat unique partage entre la barre
// d'adresse (chrome.html) et la barre centrale de l'accueil (index.html) pour
// que le degrade IA s'affiche simultanement sur les deux. Session uniquement.
let aiSearchOn = false;

// ----- Profils (comptes locaux, facon Chrome) --------------------------------
// Aucun profil selectionne = mode invite. Chaque profil : pseudo, couleur
// d'avatar, photo optionnelle (fichier avatars/<id>.png servi via zaalis://).

const PROFILE_COLORS = ['#4898ff','#00c4a7','#f5b400','#e8710a','#d93025','#a142f4','#24c1e0','#5f6368'];
let profiles = [];            // { id, name, color, photo } — photo = timestamp ou 0
let currentProfileId = '';    // '' = invite

function profilesFile() { return path.join(dataFolder, 'profiles.json'); }
function avatarsDir()   { return path.join(dataFolder, 'avatars'); }
function avatarPath(id) { return path.join(avatarsDir(), id + '.png'); }

function loadProfiles() {
  try {
    const d = JSON.parse(fs.readFileSync(profilesFile(), 'utf8'));
    profiles = Array.isArray(d)
      ? d.filter(p => p && p.id && p.name).map(p => ({
          id: String(p.id), name: String(p.name).slice(0, 40),
          color: PROFILE_COLORS.includes(p.color) ? p.color : PROFILE_COLORS[0],
          photo: Number(p.photo) || 0,
        }))
      : [];
  } catch { profiles = []; }
  if (currentProfileId && !profiles.some(p => p.id === currentProfileId)) currentProfileId = '';
}

function saveProfiles() {
  try { fs.writeFileSync(profilesFile(), JSON.stringify(profiles), 'utf8'); } catch {}
}

function currentProfile() { return profiles.find(p => p.id === currentProfileId) || null; }

function profileById(id) { return profiles.find(p => p.id === id) || null; }

function createProfile(name) {
  name = String(name || '').replace(/\x1f/g, ' ').trim().slice(0, 40);
  if (!name) name = 'Profil ' + (profiles.length + 1);
  const p = {
    id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name,
    color: PROFILE_COLORS[profiles.length % PROFILE_COLORS.length],
    photo: 0,
  };
  profiles.push(p);
  currentProfileId = p.id;
  saveProfiles();
  saveSettings();
  refreshAfterProfileSwitch();   // nouveau profil = donnees vierges, bien separees
}

function selectProfile(id) {
  if (id && !profileById(id)) return;
  if ((id || '') === currentProfileId) return;
  currentProfileId = id || '';
  saveSettings();
  refreshAfterProfileSwitch();   // bascule = jeu de donnees du profil cible
}

function renameProfile(id, name) {
  const p = profileById(id);
  name = String(name || '').trim().slice(0, 40);
  if (!p || !name) return;
  p.name = name;
  saveProfiles();
  pushState();
}

function setProfileColor(id, color) {
  const p = profileById(id);
  if (!p || !PROFILE_COLORS.includes(color)) return;
  p.color = color;
  saveProfiles();
  pushState();
}

function deleteProfile(id) {
  const i = profiles.findIndex(p => p.id === id);
  if (i < 0) return;
  const wasCurrent = currentProfileId === id;
  profiles.splice(i, 1);
  try { fs.unlinkSync(avatarPath(id)); } catch {}
  // Efface aussi les donnees du profil supprime (dossier dedie).
  try { fs.rmSync(path.join(dataFolder, 'profiles', id), { recursive: true, force: true }); } catch {}
  if (wasCurrent) {
    currentProfileId = '';
    saveSettings();
    saveProfiles();
    refreshAfterProfileSwitch();   // repli sur l'invite + ses donnees
    return;
  }
  saveProfiles();
  pushState();
}

// Choix d'une photo de profil via le selecteur natif ; recadree en 256x256
// et stockee dans le dossier de donnees.
async function chooseProfilePhoto(id) {
  const p = profileById(id);
  if (!p || !mainWin) return;
  let r;
  try {
    r = await dialog.showOpenDialog(mainWin, {
      title: 'Choisir une photo de profil',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    });
  } catch { return; }
  if (!r || r.canceled || !r.filePaths || !r.filePaths[0]) return;
  let img = nativeImage.createFromPath(r.filePaths[0]);
  if (img.isEmpty()) return;
  // Recadrage carre centre puis reduction : evite les avatars deformes.
  const sz = img.getSize();
  const side = Math.min(sz.width, sz.height);
  if (side > 0 && sz.width !== sz.height) {
    img = img.crop({
      x: Math.floor((sz.width - side) / 2),
      y: Math.floor((sz.height - side) / 2),
      width: side, height: side,
    });
  }
  img = img.resize({ width: 256, height: 256 });
  try {
    fs.mkdirSync(avatarsDir(), { recursive: true });
    fs.writeFileSync(avatarPath(id), img.toPNG());
  } catch { return; }
  p.photo = Date.now();
  saveProfiles();
  pushState();
}

// ----- Persistance -----------------------------------------------------------

function ensureDataFolder() {
  dataFolder = path.join(app.getPath('appData'), 'zaalis browser');
  try { fs.mkdirSync(dataFolder, { recursive: true }); } catch {}
}

// Alias sur le Bureau au premier lancement, seulement quand l'app est
// installée dans /Applications (ne pollue pas les runs de dev).
function ensureDesktopAlias() {
  try {
    const appPath = app.getAppPath();
    if (!appPath.startsWith('/Applications/')) return;
    const marker = path.join(dataFolder, '.desktop-alias-installed');
    if (fs.existsSync(marker)) return;
    const desktop = app.getPath('desktop');
    const alias = path.join(desktop, 'zaalis browser.app');
    if (!fs.existsSync(alias)) {
      // AppleScript pour créer un vrai alias Finder (pas un symlink cassé).
      const script = `tell application "Finder" to make alias file to (POSIX file "/Applications/zaalis Browser.app") at (POSIX file "${desktop}")`;
      require('child_process').execFile('/usr/bin/osascript', ['-e', script], (err) => {
        if (err) {
          // Fallback : symlink simple.
          try { fs.symlinkSync('/Applications/zaalis browser.app', alias); } catch {}
        }
        try { fs.writeFileSync(marker, '1'); } catch {}
      });
    } else {
      fs.writeFileSync(marker, '1');
    }
  } catch {}
}

// Dossier de donnees du profil courant. Chaque profil a ses propres favoris /
// raccourcis / historique / lanceur, bien separes. L'invite (aucun profil)
// utilise la racine du dossier de donnees (compat avec les donnees existantes).
function profileDataDir() {
  if (!currentProfileId) return dataFolder;
  const d = path.join(dataFolder, 'profiles', currentProfileId);
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

function readTsv(name) {
  const p = path.join(profileDataDir(), name);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).map(l => {
    const t = l.indexOf('\t');
    if (t < 0) return null;
    const url = l.slice(0, t), title = l.slice(t + 1);
    return url ? { url, title } : null;
  }).filter(Boolean);
}

function writeTsv(name, list) {
  const p = path.join(profileDataDir(), name);
  fs.writeFileSync(p, list.map(e => e.url + '\t' + (e.title || '')).join('\n'), 'utf8');
}

// ----- Lanceur : persistance par profil -------------------------------------
function launcherFile() { return path.join(profileDataDir(), 'launcher.json'); }
function loadLauncher() {
  launcherMode = 'travail'; launcherApps = [];
  try {
    const d = JSON.parse(fs.readFileSync(launcherFile(), 'utf8'));
    if (d.mode === 'creatif' || d.mode === 'travail') launcherMode = d.mode;
    if (Array.isArray(d.creative)) launcherApps = d.creative
      .filter(x => x && x.url)
      .map(x => ({ url: String(x.url), title: String(x.title || x.url).slice(0, 60) }))
      .slice(0, 30);
  } catch {}
}
function saveLauncher() {
  try { fs.writeFileSync(launcherFile(), JSON.stringify({ mode: launcherMode, creative: launcherApps })); } catch {}
}
function normalizeShortcutUrl(u) {
  u = String(u || '').trim();
  if (!u) return '';
  if (/^[a-z][a-z0-9+.\-]*:\/\//i.test(u)) return u;
  return 'https://' + u.replace(/^\/+/, '');
}

// Recharge toutes les donnees liees au profil (favoris, raccourcis, historique,
// lanceur) depuis le dossier du profil courant.
function loadProfileData() {
  bookmarks = readTsv('bookmarks.tsv');
  shortcuts = readTsv('shortcuts.tsv');
  history   = readTsv('history.tsv');
  loadLauncher();
}

// Applique un changement de profil : recharge les donnees et rafraichit l'UI.
function refreshAfterProfileSwitch() {
  loadProfileData();
  pushState();
  pushShortcuts();
  pushPanelState();
  sendPanelHistory();
}

function loadSettings() {
  const p = path.join(dataFolder, 'settings.txt');
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const k = line.slice(0, eq), v = line.slice(eq + 1);
      if (k === 'theme')                       settings.theme = v === 'dark' ? 'dark' : 'light';
      else if (k === 'offline')                settings.offline = v === '1';
      else if (k === 'searchEngine' &&
               ['google','bing','duckduckgo','brave'].includes(v)) settings.searchEngine = v;
      else if (k === 'showBookmarks')          settings.showBookmarks = v !== '0';
      else if (k === 'historyEnabled')         settings.historyEnabled = v !== '0';
      else if (k === 'blockPopups')            settings.blockPopups = v === '1';
      else if (k === 'contextMenus')           settings.contextMenus = v !== '0';
      else if (k === 'devTools')               settings.devTools = v !== '0';
      else if (k === 'statusBar')              settings.statusBar = v !== '0';
      else if (k === 'zoomControls')           settings.zoomControls = v !== '0';
      else if (k === 'safeSearch')             settings.safeSearch = v === '1';
      else if (k === 'aiProvider' && AI_PROVIDERS[v]) settings.aiProvider = v;
      else if (k === 'aiSubmodel' && v)        settings.aiSubmodel = v;
      else if (k === 'aiOverview')             settings.aiOverview = v !== '0';
      else if (k === 'aiConnectEnabled')       settings.aiConnectEnabled = v !== '0';
      else if (k === 'zoomPct')                settings.zoomPct = Math.max(67, Math.min(200, parseInt(v,10) || 100));
      else if (k === 'currentProfile')         currentProfileId = v || '';
    }
  }
  // Cohérence provider/sous-modèle (fichier édité à la main, ancienne version…).
  if (!validAiChoice(settings.aiProvider, settings.aiSubmodel)) {
    settings.aiSubmodel = AI_PROVIDERS[settings.aiProvider].submodels[0];
  }
  // Les favoris / raccourcis / historique / lanceur sont propres au profil :
  // charges par loadProfileData() une fois le profil courant connu.
}

function saveSettings() {
  const lines = [
    `theme=${settings.theme}`,
    `offline=${settings.offline ? 1 : 0}`,
    `searchEngine=${settings.searchEngine}`,
    `showBookmarks=${settings.showBookmarks ? 1 : 0}`,
    `historyEnabled=${settings.historyEnabled ? 1 : 0}`,
    `blockPopups=${settings.blockPopups ? 1 : 0}`,
    `contextMenus=${settings.contextMenus ? 1 : 0}`,
    `devTools=${settings.devTools ? 1 : 0}`,
    `statusBar=${settings.statusBar ? 1 : 0}`,
    `zoomControls=${settings.zoomControls ? 1 : 0}`,
    `safeSearch=${settings.safeSearch ? 1 : 0}`,
    `aiProvider=${settings.aiProvider}`,
    `aiSubmodel=${settings.aiSubmodel}`,
    `aiOverview=${settings.aiOverview ? 1 : 0}`,
    `aiConnectEnabled=${settings.aiConnectEnabled ? 1 : 0}`,
    `zoomPct=${settings.zoomPct}`,
    `currentProfile=${currentProfileId}`,
  ];
  fs.writeFileSync(path.join(dataFolder, 'settings.txt'), lines.join('\n'), 'utf8');
}

const saveBookmarks = () => writeTsv('bookmarks.tsv', bookmarks);
const saveHistory   = () => writeTsv('history.tsv',   history);
const saveShortcuts = () => writeTsv('shortcuts.tsv', shortcuts);

// ----- Utilitaires ----------------------------------------------------------

function isInternal(u) {
  return !u || u === 'about:blank' || u.startsWith('zaalis://') || u.includes('zaalis.home');
}

function resolveQuery(q) {
  q = (q || '').trim();
  if (!q) return HOME_URL;
  if (/^[a-z][a-z0-9+.\-]*:/i.test(q)) return q;
  // localhost / IP / hôte avec port
  if (/^(localhost|(\d{1,3}\.){3}\d{1,3})(:\d+)?(\/|$|\?|#)/i.test(q)) return 'http://' + q;
  // Contient un point + un TLD >=2 lettres et pas d'espace -> URL directe.
  if (!q.includes(' ') && /^[^\s]+\.[a-z]{2,63}([\/?#].*)?$/i.test(q)) return 'https://' + q;
  const engines = {
    google:     'https://www.google.com/search?q=',
    bing:       'https://www.bing.com/search?q=',
    duckduckgo: 'https://duckduckgo.com/?q=',
    brave:      'https://search.brave.com/search?q=',
  };
  const base = engines[settings.searchEngine] || engines.google;
  const safe = settings.safeSearch ? '&safe=active' : '';
  return base + encodeURIComponent(q) + safe;
}

// ----- Recherche IA (zaalis labs ide) ---------------------------------------
// Le moteur IA recupere de vrais resultats web (via DuckDuckGo HTML, cote
// process principal pour eviter les blocages CORS), les analyse, puis produit
// une page de resultats interne. Le modele choisi (settings.aiModel) pilote le
// libelle et la synthese. Aucune cle secrete n'est embarquee : la synthese est
// construite localement a partir des extraits des sources.

const AI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
              '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function httpGet(urlStr, headers) {
  return new Promise((resolve, reject) => {
    let req;
    try { req = net.request({ url: urlStr, redirect: 'follow' }); }
    catch (e) { reject(e); return; }
    req.setHeader('User-Agent', AI_UA);
    req.setHeader('Accept', 'text/html,application/xhtml+xml');
    req.setHeader('Accept-Language', 'fr-FR,fr;q=0.9,en;q=0.8');
    if (headers) for (const k of Object.keys(headers)) req.setHeader(k, headers[k]);
    const chunks = [];
    const timer = setTimeout(() => { try { req.abort(); } catch {} reject(new Error('timeout')); }, 9000);
    req.on('response', (res) => {
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end();
  });
}

// ----- Client zaalis labs ide (serveur local, port 3000) --------------------
// Le pont est authentifié par un secret partagé que le serveur IDE écrit dans
// ~/Library/Application Support/zaalis/server-data/browser-secret. Accès
// limité côté IDE au chat. Si l'IDE n'est pas lancé, chaque fonction IA du
// navigateur bascule sur son repli local.

const IDE_PORT = Number(process.env.ZAALIS_IDE_PORT) || 3000;

function ideSecretPath() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'zaalis', 'server-data', 'browser-secret');
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'zaalis', 'server-data', 'browser-secret');
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'zaalis', 'server-data', 'browser-secret');
}

function ideSecret() {
  try { return fs.readFileSync(ideSecretPath(), 'utf8').trim(); } catch { return ''; }
}

// Etat de connexion a zaalis labs ide, envoye a l'UI pour griser les
// fonctions IA quand elles ne sont pas utilisables.
// 'connected'    : IDE joignable + utilisateur connecte -> chat OK
// 'no-account'   : IDE joignable mais aucun compte -> inviter a s'inscrire
// 'unreachable'  : IDE injoignable (jamais lance, ferme, port occupe)
// 'offline'      : mode local securise actif
// 'disabled'     : la connexion a ete manuellement coupee dans les reglages
let ideStatus = 'unreachable';
let ideStatusMessage = '';
let ideStatusChecking = false;
let ideStatusTimer = null;

function setIdeStatus(status, message) {
  if (ideStatus === status && ideStatusMessage === (message || '')) return;
  ideStatus = status;
  ideStatusMessage = message || '';
  // L'IDE n'est plus joignable : on eteint le mode IA pour ne pas laisser un
  // degrade actif sur une fonction devenue indisponible.
  if (status !== 'connected' && aiSearchOn) { aiSearchOn = false; pushAiMode(); }
  pushState();
  pushPanelState();
  pushAiPanelState();
  pushAiStatusToTabs();
}

// GET rapide vers l'IDE. Ajoute le secret quand fourni pour authentifier
// via le pont navigateur.
function ideProbe(pathname, timeoutMs, withSecret) {
  return new Promise((resolve, reject) => {
    let req;
    try { req = net.request({ method: 'GET', url: 'http://127.0.0.1:' + IDE_PORT + pathname }); }
    catch (e) { reject(e); return; }
    if (withSecret) {
      const s = ideSecret();
      if (s) req.setHeader('x-zaalis-browser', s);
    }
    const chunks = [];
    const timer = setTimeout(() => { try { req.abort(); } catch {} reject(new Error('timeout')); }, timeoutMs || 2500);
    req.on('response', (res) => {
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); }
        catch { resolve({ status: res.statusCode, body: {} }); }
      });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end();
  });
}

// Determine l'etat du pont : IDE lance ? secret ecrit ? compte present ?
async function refreshIdeStatus(force) {
  if (ideStatusChecking && !force) return;
  ideStatusChecking = true;
  try {
    if (!settings.aiConnectEnabled) { setIdeStatus('disabled'); return; }
    if (settings.offline)            { setIdeStatus('offline');  return; }
    const secret = ideSecret();
    // Aucun secret : l'IDE n'a jamais ete lance sur ce Mac.
    if (!secret) { setIdeStatus('unreachable', 'zaalis labs ide n\'est pas installé ou n\'a jamais été lancé.'); return; }
    // 1) L'IDE est-il joignable ? /api/auth/me est public.
    let alive;
    try { alive = await ideProbe('/api/auth/me'); }
    catch { setIdeStatus('unreachable', 'zaalis labs ide est fermé ou ne répond pas.'); return; }
    if (alive.status !== 200) { setIdeStatus('unreachable', 'zaalis labs ide a répondu ' + alive.status + '.'); return; }
    // 2) Le pont fonctionne-t-il avec un utilisateur ? On sonde /api/gguf-models
    // (autorise via le pont) : 200 = compte trouve ; 401 = aucun compte.
    let bridged;
    try { bridged = await ideProbe('/api/gguf-models', 2500, true); }
    catch { setIdeStatus('unreachable', 'zaalis labs ide ne répond plus.'); return; }
    if (bridged.status === 401 || (bridged.body && bridged.body.error && /Authentification|Authorization/i.test(String(bridged.body.error)))) {
      setIdeStatus('no-account', 'Créez un compte ou connectez-vous dans zaalis labs ide pour commencer à utiliser les fonctions IA.');
      return;
    }
    if (bridged.status !== 200) { setIdeStatus('unreachable', 'zaalis labs ide n\'accepte pas le pont (' + bridged.status + ').'); return; }
    setIdeStatus('connected', 'Connecté à zaalis labs ide.');
  } finally {
    ideStatusChecking = false;
  }
}

function startIdeStatusWatcher() {
  refreshIdeStatus();
  if (ideStatusTimer) clearInterval(ideStatusTimer);
  ideStatusTimer = setInterval(refreshIdeStatus, 15000);
}

// POST JSON vers le serveur IDE. Rejette si indisponible / non authentifié.
function idePost(pathname, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const secret = ideSecret();
    if (!secret) { reject(new Error('no-secret')); return; }
    let req;
    try { req = net.request({ method: 'POST', url: 'http://127.0.0.1:' + IDE_PORT + pathname }); }
    catch (e) { reject(e); return; }
    req.setHeader('Content-Type', 'application/json');
    req.setHeader('x-zaalis-browser', secret);
    const chunks = [];
    const timer = setTimeout(() => { try { req.abort(); } catch {} reject(new Error('timeout')); }, timeoutMs || 45000);
    req.on('response', (res) => {
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode >= 400 || data.error) reject(new Error(data.error || ('HTTP ' + res.statusCode)));
          else resolve(data);
        } catch (e) { reject(e); }
      });
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end(JSON.stringify(body));
  });
}

// Appel chat au modèle choisi dans les réglages. Retourne { response, thinking }.
async function ideChat({ message, systemPrompt, history: turns, timeoutMs }) {
  const data = await idePost('/api/chat', {
    model: settings.aiProvider,
    submodel: settings.aiSubmodel,
    message,
    systemPrompt: systemPrompt || '',
    history: Array.isArray(turns) ? turns : [],
  }, timeoutMs);
  const text = String(data.response || '').trim();
  if (!text) throw new Error('empty-response');
  // Réponses d'erreur "douces" du serveur IDE (clé manquante, etc.).
  if (/^\[[^\]]+\]\s/.test(text) && /cle api|api key|aucune cle/i.test(text)) throw new Error('no-key:' + text);
  return { response: text, thinking: String(data.thinking || '') };
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, d) => { try { return String.fromCharCode(parseInt(d, 10)); } catch { return _m; } });
}

function stripTags(s) { return decodeEntities(String(s).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim(); }

function parseDuckDuckGo(html) {
  const results = [];
  // Bloc par resultat : de result__a (lien+titre) a la fin du snippet.
  const blockRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="[^"]*result__a|<\/html>|$)/g;
  let m;
  while ((m = blockRe.exec(html)) && results.length < 10) {
    let href = m[1];
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) { try { href = decodeURIComponent(uddg[1]); } catch {} }
    else if (href.startsWith('//')) href = 'https:' + href;
    if (!/^https?:\/\//i.test(href)) continue;
    // Ecarte les publicites DuckDuckGo (redirections y.js / ad_domain).
    if (/duckduckgo\.com\/y\.js/i.test(href) || /[?&]ad_domain=/i.test(href)) continue;
    const title = stripTags(m[2]);
    if (!title) continue;
    const sn = m[3].match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    const snippet = sn ? stripTags(sn[1]) : '';
    results.push({ url: href, title, snippet });
  }
  return results;
}

// Repli 1 : API JSON DuckDuckGo (pas de captcha). Fournit un resume "Abstract"
// et des sujets connexes. On l'utilise quand le scraping HTML est bloque.
async function fetchDdgJson(q) {
  try {
    const raw = await httpGet('https://api.duckduckgo.com/?q=' + encodeURIComponent(q) +
                              '&format=json&no_html=1&no_redirect=1&t=zaalis');
    const d = JSON.parse(raw);
    const results = [];
    if (d.AbstractURL && d.Heading) {
      results.push({ url: d.AbstractURL, title: d.Heading, snippet: d.AbstractText || '' });
    }
    const flat = [];
    for (const it of (d.RelatedTopics || [])) {
      if (it.FirstURL && it.Text) flat.push(it);
      else if (Array.isArray(it.Topics)) for (const s of it.Topics) if (s.FirstURL && s.Text) flat.push(s);
    }
    for (const it of flat.slice(0, 7)) {
      const t = String(it.Text);
      results.push({ url: it.FirstURL, title: t.split(' - ')[0].slice(0, 90), snippet: t });
    }
    return { abstract: d.AbstractText || '', results };
  } catch { return { abstract: '', results: [] }; }
}

// Repli 2 : suggestions Wikipedia (toujours disponibles pour les sujets connus).
async function fetchWikipedia(q) {
  try {
    const raw = await httpGet('https://fr.wikipedia.org/w/api.php?action=opensearch&format=json&limit=5&search=' +
                              encodeURIComponent(q));
    const a = JSON.parse(raw);
    const titles = a[1] || [], descs = a[2] || [], urls = a[3] || [];
    return titles.map((t, i) => ({ url: urls[i], title: t, snippet: descs[i] || 'Article Wikipedia.' }))
                 .filter(r => r.url);
  } catch { return []; }
}

// Suggestions de saisie (facon Google) : recuperees cote process principal
// pour eviter les blocages CORS depuis les pages internes. On interroge l'API
// de completion Google (client=firefox -> JSON simple), avec repli DuckDuckGo.
// Format Google : ["requete", ["sugg1", "sugg2", ...], [], {...}].
async function fetchSuggest(q) {
  q = (q || '').trim();
  if (!q) return [];
  const lang = 'fr';
  try {
    const raw = await httpGet('https://suggestqueries.google.com/complete/search?client=firefox&hl=' +
                              lang + '&q=' + encodeURIComponent(q));
    const a = JSON.parse(raw);
    if (Array.isArray(a) && Array.isArray(a[1]) && a[1].length) {
      return a[1].filter(s => typeof s === 'string').slice(0, 8);
    }
  } catch { /* repli ci-dessous */ }
  try {
    const raw = await httpGet('https://duckduckgo.com/ac/?q=' + encodeURIComponent(q) + '&type=list');
    const a = JSON.parse(raw);
    if (Array.isArray(a) && Array.isArray(a[1])) return a[1].filter(s => typeof s === 'string').slice(0, 8);
  } catch { /* aucune suggestion */ }
  return [];
}

// Deduplique par URL en preservant l'ordre.
function dedupeResults(list) {
  const seen = new Set(), out = [];
  for (const r of list) { if (r && r.url && !seen.has(r.url)) { seen.add(r.url); out.push(r); } }
  return out;
}

// Resultats de repli quand le reseau echoue : liens vers les moteurs reels.
function fallbackResults(q) {
  const e = encodeURIComponent(q);
  return [
    { url: 'https://www.google.com/search?q=' + e,  title: 'Rechercher « ' + q + ' » sur Google',     snippet: 'Ouvrir les resultats Google pour cette requete.' },
    { url: 'https://duckduckgo.com/?q=' + e,         title: 'Rechercher « ' + q + ' » sur DuckDuckGo', snippet: 'Ouvrir les resultats DuckDuckGo pour cette requete.' },
    { url: 'https://en.wikipedia.org/w/index.php?search=' + e, title: 'Wikipedia — ' + q,               snippet: 'Chercher un article encyclopedique correspondant.' },
  ];
}

function buildOverview(q, results) {
  const parts = results.slice(0, 3).map(r => r.snippet).filter(Boolean);
  let txt = parts.join(' ');
  if (txt.length > 620) txt = txt.slice(0, 620).replace(/\s+\S*$/, '') + '…';
  if (!txt) txt = 'Voici les resultats les plus pertinents trouves pour « ' + q +' ».';
  return txt;
}

// Navigation d'une requete IA : URL directe -> navigation normale ;
// sinon on ouvre la page de resultats interne (la requete voyage via le hash).
function aiSearch(q) {
  q = (q || '').trim();
  if (!q) return;
  if (/^[a-z][a-z0-9+.\-]*:\/\//i.test(q) ||
      (!q.includes(' ') && /^[^\s]+\.[a-z]{2,63}([\/?#].*)?$/i.test(q))) {
    navigateActive(resolveQuery(q));
    return;
  }
  // Non connecte : on bascule sur une recherche classique et on rappelle le
  // statut via la barre pour que l'UI le signale.
  if (ideStatus !== 'connected') { refreshIdeStatus(true); navigateActive(resolveQuery(q)); return; }
  navigateActive('zaalis://home/aisearch.html#' + encodeURIComponent(q));
}

// Execute la recherche IA et renvoie les resultats a l'onglet demandeur.
// Strategie en couches : d'abord les vrais resultats web (DuckDuckGo HTML),
// puis, si bloque, l'API JSON (resume + connexes) et Wikipedia. En dernier
// recours, des liens directs vers les moteurs. La synthese privilegie le
// resume factuel quand il existe, sinon un condense des extraits.
async function runAiSearch(q, sender) {
  if (!sender) return;
  q = (q || '').trim();
  const model = aiModelLabel();
  const reply = (payload) => {
    try { sender.send('zaalis:message', Object.assign({ type: 'aiResults', query: q, model }, payload)); }
    catch {}
  };
  if (!q) { reply({ results: [], overview: '', error: 'empty' }); return; }
  if (settings.offline) { reply({ results: [], overview: '', error: 'offline' }); return; }

  let results = [], abstract = '', error = null;

  // 1) Vrais resultats web via le HTML DuckDuckGo (ideal sur IP residentielle).
  try {
    const html = await httpGet('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q) + '&kl=fr-fr');
    results = parseDuckDuckGo(html);
  } catch { /* on bascule sur les replis */ }

  // 2) Replis JSON + Wikipedia si le scraping n'a rien donne (captcha, blocage).
  if (results.length < 3) {
    const [json, wiki] = await Promise.all([fetchDdgJson(q), fetchWikipedia(q)]);
    abstract = json.abstract || '';
    results = dedupeResults([...results, ...json.results, ...wiki]);
  }

  // 3) Dernier recours : liens directs vers les moteurs.
  if (!results.length) { results = fallbackResults(q); error = 'empty-results'; }

  results = results.slice(0, 10);

  // Envoie d'abord les sources (affichage immediat), puis la synthese.
  let overview = '', aiLive = false;
  if (settings.aiOverview) overview = abstract && abstract.length > 40 ? abstract : buildOverview(q, results);
  reply({ results, overview, error, pendingAi: settings.aiOverview && !error });

  // Synthese generative par le modele choisi, via zaalis labs ide. En cas
  // d'indisponibilite (IDE ferme, pas de cle), la synthese locale reste.
  if (settings.aiOverview && !error) {
    try {
      const src = results.slice(0, 6).map((r, i) =>
        `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet || ''}`).join('\n\n');
      const out = await ideChat({
        message: 'Requete de recherche : « ' + q + ' »\n\nSources :\n\n' + src,
        systemPrompt: 'Tu es le moteur de recherche IA du navigateur zaalis. A partir des sources fournies, redige en francais une synthese factuelle de 2 a 4 phrases qui repond directement a la requete. Pas de titre, pas de liste, pas de mention des numeros de sources. Si les sources ne permettent pas de repondre, dis-le simplement.',
        timeoutMs: 30000,
      });
      overview = out.response;
      aiLive = true;
    } catch { /* la synthese locale deja envoyee fait foi */ }
    reply({ results, overview, error, aiLive });
  }
}

// Page d'erreur maison (chargée quand une navigation échoue).
function errorPageHtml(u, code, desc) {
  let host = u;
  try { host = new URL(u).host || u; } catch {}
  const dark = settings.theme === 'dark';
  const bg   = dark ? '#202124' : '#e9eaed';
  const fg   = dark ? '#e8eaed' : '#202124';
  const mut  = dark ? '#9aa0a6' : '#5f6368';
  const accent = dark ? '#8ab4f8' : '#1a73e8';
  // Petite table code -> libellé
  const knownCodes = {
    '-105': 'DNS_INTROUVABLE',
    '-106': 'CONNEXION_INTERROMPUE',
    '-109': 'ADRESSE_INJOIGNABLE',
    '-137': 'DNS_INTROUVABLE',
    '-118': 'DELAI_DE_CONNEXION_DEPASSE',
    '-501': 'CERTIFICAT_NON_VALIDE',
    '-200': 'CERTIFICAT_NON_VALIDE',
  };
  const shortCode = knownCodes[String(code)] || `ERREUR_${code}`;
  const encHost = String(host).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
  const encUrl  = String(u).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Page inaccessible</title>
<style>
  html,body{margin:0;height:100%;background:${bg};color:${fg};font-family:-apple-system,"Segoe UI",Arial,sans-serif;}
  .wrap{max-width:640px;margin:0 auto;padding:96px 32px;}
  h1{font-size:26px;font-weight:600;margin:0 0 12px;}
  p{font-size:15px;line-height:1.5;color:${mut};margin:0 0 10px;}
  code{background:${dark?'#303134':'#f1f3f4'};padding:1px 6px;border-radius:4px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;}
  .actions{margin-top:28px;display:flex;gap:10px;flex-wrap:wrap;}
  button{background:${accent};color:${dark?'#202124':'#fff'};border:0;border-radius:8px;padding:9px 18px;font-size:14px;font-weight:500;cursor:pointer;}
  button.ghost{background:transparent;color:${accent};border:1px solid ${accent};}
  .details{margin-top:36px;font-size:13px;color:${mut};}
  .details b{color:${fg};font-weight:600;}
</style></head><body><div class="wrap">
  <h1>Ce site est inaccessible</h1>
  <p>Vérifiez que l'adresse <code>${encHost}</code> est correcte.</p>
  <div class="actions">
    <button onclick="location.reload()">Réessayer</button>
    <button class="ghost" onclick="history.back()">Retour</button>
  </div>
  <div class="details"><b>${shortCode}</b><br>${encUrl}</div>
</div></body></html>`;
}

function activeTab() { return active >= 0 ? tabs[active] : null; }

function pushHistory(u, title) {
  if (!settings.historyEnabled) return;
  if (!u || isInternal(u)) return;
  const last = history[history.length - 1];
  if (last && last.url === u) { last.title = title || last.title; saveHistory(); return; }
  history.push({ url: u, title: title || u });
  if (history.length > 2000) history.shift();
  saveHistory();
}

function removeHistoryUrl(u) {
  history = history.filter(e => e.url !== u);
  saveHistory();
  sendPanelHistory();
  pushPanelState();
}

// ----- Layout ---------------------------------------------------------------

function layoutAll() {
  if (!mainWin || !chromeView) return;
  const [w, h] = mainWin.getContentSize();
  chromeView.setBounds({ x: 0, y: 0, width: w, height: chromeHeight });

  const bodyTop = contentTop;
  const bodyHeight = Math.max(0, h - bodyTop);

  // Vue fractionnee : si l'onglet actif fait partie de la paire, les deux
  // membres se partagent la largeur, colles bord a bord (aucune demarcation).
  const pair = currentSplitTabs();
  const half = Math.floor(w / 2);
  for (let i = 0; i < tabs.length; i++) {
    const t = tabs[i];
    if (pair && (t.id === pair[0].id || t.id === pair[1].id)) {
      const isLeft = t.id === pair[0].id;
      // La vue de droite deborde d'1px sous celle de gauche : sans ce
      // recouvrement, le fond de fenetre transparait sur le joint sub-pixel
      // (trait noir). Chrome n'a aucune demarcation -> on l'imite.
      t.view.setBounds({
        x: isLeft ? 0 : half - 1,
        y: bodyTop,
        width: isLeft ? half : Math.max(0, w - half + 1),
        height: bodyHeight,
      });
      t.view.setVisible(true);
    } else if (!pair && i === active) {
      t.view.setBounds({ x: 0, y: bodyTop, width: w, height: bodyHeight });
      t.view.setVisible(true);
    } else {
      t.view.setVisible(false);
    }
  }

  if (panelView) {
    if (panelProgress > 0) {
      // Aligné sur kPanelTopDip = 94 comme le natif Windows.
      const panelTop = 94;
      // On garde la panelView à sa taille fixe et on ne translate que via x
      // pour éviter tout reflow interne pendant l'animation.
      const off = Math.round(PANEL_WIDTH * (1 - panelProgress));
      panelView.setBounds({
        x: Math.max(0, w - PANEL_WIDTH + off),
        y: panelTop,
        width: PANEL_WIDTH,
        height: Math.max(0, h - panelTop),
      });
      panelView.setVisible(true);
    } else {
      panelView.setVisible(false);
    }
  }

  // Panneau chat IA : meme mecanique de glissement que le panneau parametres.
  if (aiPanelView) {
    if (aiPanelProgress > 0) {
      const panelTop = 94;
      const off = Math.round(AI_PANEL_WIDTH * (1 - aiPanelProgress));
      aiPanelView.setBounds({
        x: Math.max(0, w - AI_PANEL_WIDTH + off),
        y: panelTop,
        width: AI_PANEL_WIDTH,
        height: Math.max(0, h - panelTop),
      });
      aiPanelView.setVisible(true);
    } else {
      aiPanelView.setVisible(false);
    }
  }
}

// ----- État -> chrome / panel -----------------------------------------------

function pushState() {
  if (!chromeView) return;
  const a = activeTab();
  const activeUrl   = a ? a.view.webContents.getURL()   : '';
  const activeTitle = a ? a.view.webContents.getTitle() : '';
  const canBack = a ? a.view.webContents.navigationHistory.canGoBack() : false;
  const canFwd  = a ? a.view.webContents.navigationHistory.canGoForward() : false;
  const marked = !isInternal(activeUrl) && bookmarks.some(b => b.url === activeUrl);

  const msg = {
    type: 'state',
    theme: settings.theme,
    searchEngine: settings.searchEngine,
    offline: settings.offline,
    showBookmarks: settings.showBookmarks,
    tabs: tabs.map((t, i) => ({
      id: t.id,
      title: t.view.webContents.getTitle() || '',
      url:   t.view.webContents.getURL()   || '',
      active: i === active,
    })),
    active: {
      url: activeUrl,
      title: activeTitle,
      canBack,
      canForward: canFwd,
      loading: !!(a && a.loading),
      isBookmarked: marked,
    },
    bookmarks: bookmarks.map(b => ({ url: b.url, title: b.title })),
    split: splitPair ? splitPair.slice() : null,
    profile: {
      currentId: currentProfileId,
      current: currentProfile()
        ? (({ id, name, color, photo }) => ({ id, name, color, photo }))(currentProfile())
        : null,
      list: profiles.map(p => ({ id: p.id, name: p.name, color: p.color, photo: p.photo })),
    },
    aiStatus: ideStatus,
    aiStatusMessage: ideStatusMessage,
    aiConnected: ideStatus === 'connected',
    aiConnectEnabled: settings.aiConnectEnabled,
    aiMode: aiSearchOn,
    launcherMode,
    launcherApps: launcherApps.map(a => ({ url: a.url, title: a.title })),
    launcherWork: WORK_APPS,
    panelOpen,
    aiPanelOpen,
  };
  chromeView.webContents.send('zaalis:message', msg);
}

function pushPanelState() {
  if (!panelView) return;
  panelView.webContents.send('zaalis:message', {
    type: 'state',
    theme: settings.theme,
    searchEngine: settings.searchEngine,
    offline: settings.offline,
    showBookmarks: settings.showBookmarks,
    historyEnabled: settings.historyEnabled,
    blockPopups: settings.blockPopups,
    contextMenus: settings.contextMenus,
    devTools: settings.devTools,
    statusBar: settings.statusBar,
    zoomControls: settings.zoomControls,
    safeSearch: settings.safeSearch,
    aiProvider: settings.aiProvider,
    aiSubmodel: settings.aiSubmodel,
    aiOverview: settings.aiOverview,
    aiProviders: Object.fromEntries(Object.entries(AI_PROVIDERS).map(([k, p]) =>
      [k, { label: p.label, submodels: p.submodels }])),
    aiModelLabels: AI_MODEL_LABELS,
    aiConnectEnabled: settings.aiConnectEnabled,
    aiStatus: ideStatus,
    aiStatusMessage: ideStatusMessage,
    zoomPct: settings.zoomPct,
    historyCount: history.length,
    bookmarkCount: bookmarks.length,
  });
}

function pushShortcuts() {
  const msg = { type: 'shortcuts', items: shortcuts.map(s => ({ url: s.url, title: s.title })) };
  for (const t of tabs) {
    const u = t.view.webContents.getURL();
    if (isInternal(u)) t.view.webContents.send('zaalis:message', msg);
  }
}

// Diffuse l'etat du mode recherche IA a la barre d'adresse (chrome) et aux
// pages d'accueil : les deux barres allument leur degrade en meme temps.
function pushAiMode() {
  const msg = { type: 'aiMode', on: aiSearchOn };
  if (chromeView) chromeView.webContents.send('zaalis:message', msg);
  for (const t of tabs) {
    const u = t.view.webContents.getURL();
    if (isInternal(u)) t.view.webContents.send('zaalis:message', msg);
  }
}

// Diffuse l'etat de la connexion IA aux pages internes (accueil, recherche IA).
function pushAiStatusToTabs() {
  const msg = {
    type: 'aiStatus', connected: ideStatus === 'connected',
    status: ideStatus, message: ideStatusMessage,
  };
  for (const t of tabs) {
    const u = t.view.webContents.getURL();
    if (isInternal(u)) t.view.webContents.send('zaalis:message', msg);
  }
}

function sendPanelHistory() {
  if (!panelView) return;
  const items = [];
  for (let i = history.length - 1; i >= 0; i--) items.push({ url: history[i].url, title: history[i].title });
  panelView.webContents.send('zaalis:message', { type: 'history', items });
}

// ----- Onglets --------------------------------------------------------------

function applyWebSettings(view) {
  const wc = view.webContents;
  wc.setZoomFactor(settings.zoomPct / 100);
  wc.setAudioMuted(false);
}

function createTab(rawUrl, activate) {
  const preload = path.join(__dirname, 'preload-content.js');
  const partition = 'persist:zaalis-browser';
  const view = new WebContentsView({
    webPreferences: {
      preload,
      partition,
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
      spellcheck: true,
    },
  });
  view.setBackgroundColor('#00000000');

  const tab = { id: nextId++, view, loading: false };
  tabs.push(tab);

  const wc = view.webContents;

  // Popups -> nouvel onglet
  wc.setWindowOpenHandler(({ url }) => {
    if (settings.blockPopups) return { action: 'deny' };
    createTab(url, true);
    return { action: 'deny' };
  });

  wc.on('did-start-loading', () => { tab.loading = true;  pushState(); });
  wc.on('did-stop-loading',  () => { tab.loading = false; pushState(); });
  wc.on('page-title-updated',   () => pushState());
  wc.on('did-navigate',         (_e, u) => { pushHistory(u, wc.getTitle()); pushState(); });
  wc.on('did-navigate-in-page', () => pushState());

  wc.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
    // -3 = ERR_ABORTED (navigation annulée par l'utilisateur ou redirigée)
    if (!isMainFrame || code === -3) return;
    const html = errorPageHtml(failedUrl, code, desc);
    wc.loadURL('data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf8').toString('base64'), {
      baseURLForDataURL: failedUrl,
    });
  });

  wc.on('context-menu', (event, params) => {
    if (!settings.contextMenus) { event.preventDefault(); return; }
    const items = [];
    // IA : résumé/chat sur la page courante via zaalis labs ide.
    items.push({ label: 'Demander à l\'IA — résumé de la page', click: () => askAiAboutPage() });
    items.push({ type: 'separator' });
    if (params.linkURL) {
      items.push({ label: 'Ouvrir dans un nouvel onglet', click: () => createTab(params.linkURL, true) });
      items.push({ label: 'Copier l\'adresse du lien',    click: () => require('electron').clipboard.writeText(params.linkURL) });
      items.push({ type: 'separator' });
    }
    if (params.selectionText) {
      items.push({ label: 'Copier', role: 'copy' });
      items.push({ type: 'separator' });
    }
    items.push({ label: 'Reculer',   enabled: wc.navigationHistory.canGoBack(),    click: () => wc.navigationHistory.goBack() });
    items.push({ label: 'Avancer',   enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() });
    items.push({ label: 'Actualiser', click: () => wc.reload() });
    if (settings.devTools) {
      items.push({ type: 'separator' });
      items.push({ label: 'Inspecter', click: () => wc.inspectElement(params.x, params.y) });
    }
    Menu.buildFromTemplate(items).popup();
  });

  // Injecte le thème avant chaque navigation (comme AddScriptToExecuteOnDocumentCreated).
  const injectTheme = () => {
    const t = settings.theme === 'dark' ? 'dark' : 'light';
    wc.executeJavaScript(`
      try { localStorage.setItem('zaalis_theme', '${t}'); } catch (e) {}
      if (document.body) {
        document.body.classList.toggle('dark-mode', '${t}' === 'dark');
        document.body.classList.toggle('dark',      '${t}' === 'dark');
      }
    `).catch(() => {});
  };
  wc.on('dom-ready', injectTheme);

  applyWebSettings(view);
  mainWin.contentView.addChildView(view);

  // Insertion sous chromeView / panel dans le z-order (les added-last sont au-dessus).
  // On remonte chromeView et panelView après.
  if (chromeView) { mainWin.contentView.addChildView(chromeView); }
  if (panelView && panelOpen) { mainWin.contentView.addChildView(panelView); }
  if (aiPanelView && aiPanelOpen) { mainWin.contentView.addChildView(aiPanelView); }

  wc.loadURL(rawUrl && rawUrl.length ? resolveQuery(rawUrl) : HOME_URL);

  if (activate) selectTab(tab.id);
  else { layoutAll(); pushState(); }
}

// ----- Vue fractionnee (2 onglets max, comme Chrome) -------------------------

// Retourne [tabGauche, tabDroite] si la paire est valide ET que l'onglet actif
// en fait partie (sinon la paire reste memorisee mais masquee).
function currentSplitTabs() {
  if (!splitPair) return null;
  const a = tabs.find(t => t.id === splitPair[0]);
  const b = tabs.find(t => t.id === splitPair[1]);
  if (!a || !b) { splitPair = null; return null; }
  const act = activeTab();
  if (!act || (act.id !== a.id && act.id !== b.id)) return null;
  return [a, b];
}

function setSplit(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx < 0 || tabs.length < 2) return;
  const act = activeTab();
  let otherId;
  if (act && act.id !== id) otherId = act.id;
  else {
    const nb = tabs[idx + 1] || tabs[idx - 1];   // onglet lui-meme actif : voisin
    if (!nb) return;
    otherId = nb.id;
  }
  // Ordre gauche/droite = ordre des onglets dans la barre.
  const otherIdx = tabs.findIndex(t => t.id === otherId);
  splitPair = otherIdx < idx ? [otherId, id] : [id, otherId];
  makeSplitAdjacent();
  if (!act || (act.id !== id && act.id !== otherId)) selectTab(id);
  else { layoutAll(); pushState(); }
}

// Comme Chrome : les deux onglets d'un groupe fractionne sont ramenes cote a
// cote dans la barre (le droit vient se coller au gauche).
function makeSplitAdjacent() {
  if (!splitPair) return;
  const activeId = activeTab() ? activeTab().id : -1;
  const li = tabs.findIndex(t => t.id === splitPair[0]);
  const ri = tabs.findIndex(t => t.id === splitPair[1]);
  if (li < 0 || ri < 0) return;
  if (ri !== li + 1) {
    const [moved] = tabs.splice(ri, 1);
    tabs.splice(tabs.findIndex(t => t.id === splitPair[0]) + 1, 0, moved);
  }
  active = tabs.findIndex(t => t.id === activeId);
}

function clearSplit() {
  if (!splitPair) return;
  splitPair = null;
  layoutAll();
  pushState();
}

// Menu contextuel natif au clic droit sur un onglet de la barre.
function showTabMenu(id) {
  const t = tabs.find(x => x.id === id);
  if (!t) return;
  const inSplit = !!(splitPair && splitPair.includes(id));
  const items = [];
  if (inSplit) {
    items.push({ label: 'Quitter la vue fractionnée', click: () => clearSplit() });
  } else {
    items.push({
      label: 'Vue fractionnée',
      enabled: tabs.length >= 2,
      click: () => setSplit(id),
    });
  }
  items.push({ type: 'separator' });
  items.push({ label: 'Nouvel onglet', click: () => createTab('', true) });
  items.push({ label: 'Actualiser',    click: () => t.view.webContents.reload() });
  items.push({ type: 'separator' });
  items.push({ label: 'Fermer l\'onglet', click: () => closeTab(id) });
  Menu.buildFromTemplate(items).popup();
}

function selectTab(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx < 0) return;
  active = idx;
  layoutAll();
  const t = tabs[idx];
  try { t.view.webContents.focus(); } catch {}
  pushState();
}

function closeTab(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx < 0) return;
  if (splitPair && splitPair.includes(id)) splitPair = null;  // dissout la vue fractionnee
  const t = tabs[idx];
  try { mainWin.contentView.removeChildView(t.view); } catch {}
  try { t.view.webContents.close(); } catch {}
  tabs.splice(idx, 1);
  if (tabs.length === 0) {
    active = -1;
    createTab('', true);
    return;
  }
  if (active >= tabs.length) active = tabs.length - 1;
  else if (idx < active) active--;
  layoutAll();
  pushState();
}

function reorderTabs(csv) {
  const ids = csv.split(',').map(s => parseInt(s, 10)).filter(Number.isFinite);
  const currentActiveId = activeTab() ? activeTab().id : -1;
  const map = new Map(tabs.map(t => [t.id, t]));
  const reordered = [];
  for (const id of ids) { const t = map.get(id); if (t) { reordered.push(t); map.delete(id); } }
  for (const t of tabs) if (map.has(t.id)) reordered.push(t);
  tabs.length = 0;
  tabs.push(...reordered);
  active = tabs.findIndex(t => t.id === currentActiveId);
  makeSplitAdjacent();   // la paire fractionnee reste toujours collee
  layoutAll();
  pushState();
}

function navigateActive(u) {
  const t = activeTab();
  if (!t) { createTab(u, true); return; }
  t.view.webContents.loadURL(u);
}

function toggleBookmark() {
  const t = activeTab();
  if (!t) return;
  const u = t.view.webContents.getURL();
  if (isInternal(u)) return;
  const i = bookmarks.findIndex(b => b.url === u);
  if (i >= 0) bookmarks.splice(i, 1);
  else bookmarks.push({ url: u, title: t.view.webContents.getTitle() || u });
  saveBookmarks();
  pushState();
}

function addShortcut(u, title) {
  if (!u) return;
  u = u.trim();
  if (!/^[a-z]+:\/\//i.test(u)) u = 'https://' + u;
  if (shortcuts.some(s => s.url === u)) return;
  shortcuts.push({ url: u, title: (title || u).trim() });
  saveShortcuts();
  pushShortcuts();
}

function removeShortcut(u) {
  shortcuts = shortcuts.filter(s => s.url !== u);
  saveShortcuts();
  pushShortcuts();
}

function setTheme(t) {
  settings.theme = t === 'dark' ? 'dark' : 'light';
  saveSettings();
  applyChromeTheme();
  // Applique le theme immediatement aux pages deja ouvertes (avant ce fix,
  // le mode clair/sombre ne se propageait qu'a la prochaine navigation).
  const th = settings.theme;
  for (const tab of tabs) {
    try {
      tab.view.webContents.executeJavaScript(`
        try { localStorage.setItem('zaalis_theme', '${th}'); } catch (e) {}
        if (document.body) {
          document.body.classList.toggle('dark-mode', '${th}' === 'dark');
          document.body.classList.toggle('dark',      '${th}' === 'dark');
        }
      `).catch(() => {});
    } catch {}
  }
  pushState();
  pushPanelState();
  pushAiPanelState();
}

function applyChromeTheme() {
  const bg = settings.theme === 'dark' ? '#202124' : '#e9eaed';
  if (mainWin) mainWin.setBackgroundColor(bg);
  for (const t of tabs) { try { t.view.setBackgroundColor(bg); } catch {} }
}

function setSearchEngine(e) {
  if (!['google','bing','duckduckgo','brave'].includes(e)) return;
  settings.searchEngine = e;
  saveSettings();
  pushState();
  pushPanelState();
}

function setZoomPct(v) {
  v = Math.max(67, Math.min(200, parseInt(v, 10) || 100));
  settings.zoomPct = v;
  saveSettings();
  for (const t of tabs) { try { t.view.webContents.setZoomFactor(v / 100); } catch {} }
  pushPanelState();
}

function resetSettings() {
  Object.assign(settings, {
    theme: 'light', offline: false, searchEngine: 'google',
    showBookmarks: true, historyEnabled: true, blockPopups: false,
    contextMenus: true, devTools: true, statusBar: true, zoomControls: true,
    safeSearch: false, aiProvider: 'codex', aiSubmodel: 'gpt-5.5', aiOverview: true, zoomPct: 100,
  });
  saveSettings();
  applyChromeTheme();
  for (const t of tabs) { try { t.view.webContents.setZoomFactor(1); } catch {} }
  pushState();
  pushPanelState();
}

// ----- Panneau --------------------------------------------------------------

function ensurePanelView() {
  if (panelView) return;
  panelView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-chrome.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  panelView.setBackgroundColor('#00000000');
  panelView.webContents.on('did-finish-load', () => {
    pushPanelState();
    if (pendingPanelHistory) { sendPanelHistory(); pendingPanelHistory = false; }
  });
  panelView.webContents.loadURL(PANEL_URL);
}

// easeInOutCubic, comme le natif.
function easeInOut(t) { return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3) / 2; }

function stepPanelAnim() {
  const now = Date.now();
  const dt  = Math.max(0, now - panelAnimStart);
  const p   = Math.min(1, dt / PANEL_ANIM_MS);
  panelProgress = panelAnimFrom + (panelAnimTo - panelAnimFrom) * easeInOut(p);
  layoutAll();
  if (p >= 1) {
    panelProgress = panelAnimTo;
    if (panelAnimTimer) { clearInterval(panelAnimTimer); panelAnimTimer = null; }
    layoutAll();
  }
}

function animatePanelTo(target) {
  panelAnimFrom = panelProgress;
  panelAnimTo   = target;
  panelAnimStart = Date.now();
  if (panelAnimTimer) clearInterval(panelAnimTimer);
  panelAnimTimer = setInterval(stepPanelAnim, 16);
}

function togglePanel() {
  ensurePanelView();
  panelOpen = !panelOpen;
  if (panelOpen) {
    closeAiPanel();                 // un seul panneau lateral a la fois
    mainWin.contentView.addChildView(panelView);
    animatePanelTo(1);
  } else {
    animatePanelTo(0);
  }
  pushPanelState();
  pushState();
}

function closePanel() {
  if (!panelOpen) return;
  panelOpen = false;
  animatePanelTo(0);
  pushState();
}

// ----- Panneau chat IA (zaalis labs ide) -------------------------------------
// Panneau lateral droit independant du panneau parametres : chat complet avec
// le modele choisi, conversations persistees dans aichats.json.

const AI_PANEL_WIDTH = 380;
let aiPanelView = null;
let aiPanelOpen = false;
let aiPanelProgress = 0;
let aiPanelAnimFrom = 0, aiPanelAnimTo = 0, aiPanelAnimStart = 0, aiPanelAnimTimer = null;

let aiChats = [];            // [{ id, title, createdAt, updatedAt, messages: [{role, content}] }]
let aiCurrentChatId = null;
let aiChatBusy = false;      // une requete modele a la fois

function aiChatsFile() { return path.join(dataFolder, 'aichats.json'); }

function loadAiChats() {
  try {
    const d = JSON.parse(fs.readFileSync(aiChatsFile(), 'utf8'));
    aiChats = Array.isArray(d) ? d.filter(c => c && c.id && Array.isArray(c.messages)) : [];
  } catch { aiChats = []; }
}

function saveAiChats() {
  try {
    // Garde les 80 conversations les plus recentes.
    if (aiChats.length > 80) aiChats = aiChats.slice(-80);
    fs.writeFileSync(aiChatsFile(), JSON.stringify(aiChats), 'utf8');
  } catch {}
}

function aiChatById(id) { return aiChats.find(c => c.id === id) || null; }

function newAiChat(title) {
  // Reutilise la conversation courante si elle est encore vide (evite les
  // conversations vides en serie quand on clique plusieurs fois sur "+").
  const cur = aiChatById(aiCurrentChatId);
  if (cur && cur.messages.length === 0) {
    if (title) { cur.title = title; saveAiChats(); }
    return cur;
  }
  const chat = {
    id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: title || 'Nouvelle conversation',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
  };
  aiChats.push(chat);
  aiCurrentChatId = chat.id;
  saveAiChats();
  return chat;
}

function aiPanelSend(msg) {
  if (aiPanelView) { try { aiPanelView.webContents.send('zaalis:message', msg); } catch {} }
}

function pushAiPanelState() {
  aiPanelSend({
    type: 'aiPanelState',
    theme: settings.theme,
    modelLabel: aiModelLabel(),
    providerLabel: (AI_PROVIDERS[settings.aiProvider] || {}).label || '',
    aiStatus: ideStatus,
    aiStatusMessage: ideStatusMessage,
    aiConnected: ideStatus === 'connected',
  });
}

function pushAiChatList() {
  const items = aiChats.slice().reverse().map(c => ({
    id: c.id,
    title: c.title,
    count: c.messages.length,
    updatedAt: c.updatedAt,
  }));
  aiPanelSend({ type: 'aiChats', items, currentId: aiCurrentChatId });
}

function pushAiChatMessages() {
  const chat = aiChatById(aiCurrentChatId);
  aiPanelSend({
    type: 'aiChatMessages',
    id: chat ? chat.id : null,
    title: chat ? chat.title : '',
    messages: chat ? chat.messages : [],
    busy: aiChatBusy,
  });
}

function ensureAiPanelView() {
  if (aiPanelView) return;
  aiPanelView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-chrome.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  aiPanelView.setBackgroundColor('#00000000');
  aiPanelView.webContents.on('did-finish-load', () => {
    pushAiPanelState();
    pushAiChatList();
    pushAiChatMessages();
  });
  aiPanelView.webContents.loadURL('zaalis://home/aichat.html');
}

function stepAiPanelAnim() {
  const p = Math.min(1, Math.max(0, (Date.now() - aiPanelAnimStart) / PANEL_ANIM_MS));
  aiPanelProgress = aiPanelAnimFrom + (aiPanelAnimTo - aiPanelAnimFrom) * easeInOut(p);
  layoutAll();
  if (p >= 1) {
    aiPanelProgress = aiPanelAnimTo;
    if (aiPanelAnimTimer) { clearInterval(aiPanelAnimTimer); aiPanelAnimTimer = null; }
    layoutAll();
  }
}

function animateAiPanelTo(target) {
  aiPanelAnimFrom = aiPanelProgress;
  aiPanelAnimTo   = target;
  aiPanelAnimStart = Date.now();
  if (aiPanelAnimTimer) clearInterval(aiPanelAnimTimer);
  aiPanelAnimTimer = setInterval(stepAiPanelAnim, 16);
}

function openAiPanel() {
  ensureAiPanelView();
  if (aiPanelOpen) return;
  closePanel();                     // un seul panneau lateral a la fois
  aiPanelOpen = true;
  mainWin.contentView.addChildView(aiPanelView);
  animateAiPanelTo(1);
  pushAiPanelState();
  pushAiChatList();
  pushAiChatMessages();
  pushState();
}

function closeAiPanel() {
  if (!aiPanelOpen) return;
  aiPanelOpen = false;
  animateAiPanelTo(0);
  pushState();
}

function toggleAiPanel() { aiPanelOpen ? closeAiPanel() : openAiPanel(); }

// Envoi d'un message dans la conversation courante (creee au besoin).
async function aiChatSend(text, pageContext) {
  text = String(text || '').replace(/\x1f/g, ' ').trim();
  if (!text || aiChatBusy) return;
  let chat = aiChatById(aiCurrentChatId);
  if (!chat) chat = newAiChat(text.slice(0, 44));
  if (chat.messages.length === 0 && chat.title === 'Nouvelle conversation') chat.title = text.slice(0, 44);

  const history = chat.messages.map(m => ({ role: m.role, content: m.content }));
  chat.messages.push({ role: 'user', content: text });
  chat.updatedAt = new Date().toISOString();
  saveAiChats();
  aiChatBusy = true;
  pushAiChatMessages();
  pushAiChatList();

  let reply;
  try {
    const out = await ideChat({
      message: text,
      history,
      systemPrompt:
        'Tu es l\'assistant IA du navigateur zaalis (propulse par zaalis labs ide). ' +
        'Reponds en francais, de maniere claire et concise.' +
        (pageContext ? '\n\nContexte — page web actuellement ouverte :\n' + pageContext : ''),
      timeoutMs: 90000,
    });
    reply = out.response;
  } catch (e) {
    const m = String(e && e.message || '');
    if (m.startsWith('no-key:')) reply = '⚠️ ' + m.slice(7) + '\nAjoute ta clé API dans zaalis labs ide (Paramètres → Clés API).';
    else if (m === 'no-secret') reply = '⚠️ zaalis labs ide n\'a jamais été lancé sur ce Mac. Lance-le une première fois pour activer l\'IA.';
    else if (m === 'timeout') reply = '⚠️ Le modèle met trop de temps à répondre. Réessaie.';
    else reply = '⚠️ Impossible de joindre zaalis labs ide. Vérifie qu\'il est bien lancé, puis réessaie.';
  }
  chat.messages.push({ role: 'assistant', content: reply });
  chat.updatedAt = new Date().toISOString();
  aiChatBusy = false;
  saveAiChats();
  pushAiChatMessages();
  pushAiChatList();
}

// « Demander a l'IA » : extrait le texte de la page active, ouvre le panneau
// et lance un resume dans une nouvelle conversation.
async function askAiAboutPage() {
  const t = activeTab();
  if (!t) return;
  openAiPanel();
  if (aiChatBusy) return;   // une reponse est deja en cours : on montre juste le panneau
  let info = null;
  try {
    info = await t.view.webContents.executeJavaScript(`({
      title: document.title || '',
      url: location.href,
      text: (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 8000),
    })`, true);
  } catch {}
  const title = (info && info.title) || t.view.webContents.getTitle() || 'cette page';
  const url = (info && info.url) || t.view.webContents.getURL() || '';
  newAiChat(('Résumé — ' + title).slice(0, 60));
  pushAiChatList();
  pushAiChatMessages();
  const ctx = 'Titre : ' + title + '\nURL : ' + url + '\n\nContenu :\n' + ((info && info.text) || '(contenu inaccessible)');
  aiChatSend('Fais un résumé clair et structuré de cette page.', ctx);
}

// ----- Bus de messages ------------------------------------------------------

function handleAction(a, args, event) {
  const arg = i => (i < args.length ? args[i] : '');
  switch (a) {
    case 'ready':          pushState(); pushAiStatusToTabs(); pushShortcuts(); pushAiMode(); break;
    case 'chromeHeight': {
      const h   = parseInt(arg(0), 10) || chromeHeight;
      const top = args.length > 1 ? (parseInt(arg(1), 10) || h) : h;
      chromeOverlay = args.length > 5;
      if (chromeOverlay) {
        chromeOverlayRect = {
          left:   parseInt(arg(2), 10) || 0,
          top:    parseInt(arg(3), 10) || 0,
          right:  parseInt(arg(4), 10) || 0,
          bottom: parseInt(arg(5), 10) || 0,
        };
      } else {
        chromeOverlayRect = { left:0, top:0, right:0, bottom:0 };
      }
      if (h > 40 && h < 620 && top > 40 && top < 620) {
        chromeHeight = h;
        contentTop = top;
        layoutAll();
      }
      break;
    }
    case 'newTab':         createTab('', true); break;
    case 'openInNewTab':   createTab(arg(0), true); break;
    case 'closeTab':       closeTab(parseInt(arg(0), 10)); break;
    case 'selectTab':      selectTab(parseInt(arg(0), 10)); break;
    case 'reorderTabs':    reorderTabs(arg(0)); break;
    case 'tabMenu':        showTabMenu(parseInt(arg(0), 10)); break;
    case 'splitWith':      setSplit(parseInt(arg(0), 10)); break;
    case 'unsplit':        clearSplit(); break;
    case 'navigate':       navigateActive(resolveQuery(arg(0))); break;
    case 'setAiMode': {
      // Bascule du mode IA : refusee si l'IDE n'est pas joignable (l'UI le
      // signale de son cote). Diffuse aux deux barres pour un degrade unifie.
      const on = arg(0) === '1';
      if (on && ideStatus !== 'connected') { refreshIdeStatus(true); break; }
      if (aiSearchOn !== on) { aiSearchOn = on; pushAiMode(); }
      break;
    }
    case 'suggest': {
      // Suggestions de saisie facon Google. On repond a l'emetteur (barre
      // d'adresse ou accueil). `seq` permet d'ignorer les reponses perimees.
      const seq = arg(0), q = arg(1);
      const sender = event ? event.sender : null;
      if (!sender) break;
      if (settings.offline) { try { sender.send('zaalis:message', { type: 'suggest', seq, query: q, items: [] }); } catch {} break; }
      fetchSuggest(q).then(items => {
        try { sender.send('zaalis:message', { type: 'suggest', seq, query: q, items }); } catch {}
      });
      break;
    }
    case 'aiSearch':       aiSearch(arg(0)); break;
    case 'runAiSearch':    runAiSearch(arg(0), event ? event.sender : null); break;
    case 'setAiProvider': {
      const p = arg(0);
      if (AI_PROVIDERS[p]) {
        settings.aiProvider = p;
        if (!validAiChoice(p, settings.aiSubmodel)) settings.aiSubmodel = AI_PROVIDERS[p].submodels[0];
        saveSettings(); pushPanelState(); pushAiPanelState();
      }
      break;
    }
    case 'setAiSubmodel':  if (validAiChoice(settings.aiProvider, arg(0))) { settings.aiSubmodel = arg(0); saveSettings(); pushPanelState(); pushAiPanelState(); } break;
    case 'setAiOverview':  settings.aiOverview = arg(0) === '1'; saveSettings(); pushPanelState(); break;
    case 'setAiConnect':    settings.aiConnectEnabled = arg(0) === '1'; saveSettings(); refreshIdeStatus(true); break;
    case 'refreshAiStatus': refreshIdeStatus(true); break;
    case 'toggleAiPanel':  toggleAiPanel(); break;
    case 'closeAiPanel':   closeAiPanel(); break;
    case 'askAiPage':      askAiAboutPage(); break;
    case 'aiPanelReady':   pushAiPanelState(); pushAiChatList(); pushAiChatMessages(); break;
    case 'aiChatSend':     aiChatSend(args.join(SEP)); break;
    case 'aiChatNew':      newAiChat(); pushAiChatList(); pushAiChatMessages(); break;
    case 'aiChatSelect':   if (aiChatById(arg(0))) { aiCurrentChatId = arg(0); pushAiChatList(); pushAiChatMessages(); } break;
    case 'aiChatDelete': {
      const id = arg(0);
      aiChats = aiChats.filter(c => c.id !== id);
      if (aiCurrentChatId === id) aiCurrentChatId = aiChats.length ? aiChats[aiChats.length - 1].id : null;
      saveAiChats(); pushAiChatList(); pushAiChatMessages();
      break;
    }
    case 'profileCreate':  createProfile(arg(0)); break;
    case 'profileSelect':  selectProfile(arg(0)); break;
    case 'profileRename':  renameProfile(arg(0), arg(1)); break;
    case 'profileColor':   setProfileColor(arg(0), arg(1)); break;
    case 'profileDelete':  deleteProfile(arg(0)); break;
    case 'profilePhoto':   chooseProfilePhoto(arg(0)); break;
    case 'openBookmark':   navigateActive(arg(0)); break;
    case 'removeBookmark': {
      const u = arg(0);
      const i = bookmarks.findIndex(b => b.url === u);
      if (i >= 0) { bookmarks.splice(i, 1); saveBookmarks(); pushState(); }
      break;
    }
    case 'bookmarkToggle': toggleBookmark(); break;
    case 'addShortcut':    addShortcut(arg(0), arg(1)); break;
    case 'removeShortcut': removeShortcut(arg(0)); break;
    case 'launcherSetMode':
      if (arg(0) === 'travail' || arg(0) === 'creatif') { launcherMode = arg(0); saveLauncher(); pushState(); }
      break;
    case 'launcherAdd': {
      const u = normalizeShortcutUrl(arg(0));
      if (u && !launcherApps.some(a => a.url === u) && launcherApps.length < 30) {
        launcherApps.push({ url: u, title: String(arg(1) || u).replace(/\x1f/g, ' ').trim().slice(0, 60) });
        saveLauncher(); pushState();
      }
      break;
    }
    case 'launcherRemove':
      launcherApps = launcherApps.filter(a => a.url !== arg(0));
      saveLauncher(); pushState();
      break;
    case 'launcherOpen': if (arg(0)) createTab(arg(0), true); break;
    case 'setTheme':       setTheme(arg(0)); break;
    case 'back':           { const t = activeTab(); if (t && t.view.webContents.navigationHistory.canGoBack())    t.view.webContents.navigationHistory.goBack();    break; }
    case 'forward':        { const t = activeTab(); if (t && t.view.webContents.navigationHistory.canGoForward()) t.view.webContents.navigationHistory.goForward(); break; }
    case 'reload':         { const t = activeTab(); if (t) t.view.webContents.reload(); break; }
    case 'home':           navigateActive(HOME_URL); break;
    case 'toggleMaximize': if (mainWin) { mainWin.isMaximized() ? mainWin.unmaximize() : mainWin.maximize(); } break;
    case 'togglePanel':    togglePanel(); break;
    case 'closePanel':     closePanel(); break;
    case 'panelReady':     pushPanelState(); if (pendingPanelHistory) { sendPanelHistory(); pendingPanelHistory = false; } break;
    case 'getHistory':     sendPanelHistory(); break;
    case 'openHistory':    closePanel(); navigateActive(arg(0)); break;
    case 'removeHistory':  removeHistoryUrl(arg(0)); break;
    case 'clearHistory':   history = []; saveHistory(); sendPanelHistory(); pushPanelState(); break;
    case 'clearBookmarks': bookmarks = []; saveBookmarks(); pushState(); pushPanelState(); break;
    case 'setOffline':          settings.offline = arg(0) === '1'; saveSettings(); pushState(); pushPanelState(); break;
    case 'setShowBookmarks':    settings.showBookmarks = arg(0) === '1'; saveSettings(); pushState(); pushPanelState(); break;
    case 'setHistoryEnabled':   settings.historyEnabled = arg(0) === '1'; saveSettings(); pushPanelState(); break;
    case 'setBlockPopups':      settings.blockPopups = arg(0) === '1'; saveSettings(); pushPanelState(); break;
    case 'setContextMenus':     settings.contextMenus = arg(0) === '1'; saveSettings(); pushPanelState(); break;
    case 'setDevTools':         settings.devTools = arg(0) === '1'; saveSettings(); pushPanelState(); break;
    case 'setStatusBar':        settings.statusBar = arg(0) === '1'; saveSettings(); pushPanelState(); break;
    case 'setZoomControls':     settings.zoomControls = arg(0) === '1'; saveSettings(); pushPanelState(); break;
    case 'setSafeSearch':       settings.safeSearch = arg(0) === '1'; saveSettings(); pushPanelState(); break;
    case 'setSearchEngine':     setSearchEngine(arg(0)); break;
    case 'setZoomPct':          setZoomPct(parseInt(arg(0), 10)); break;
    case 'resetSettings':       resetSettings(); break;
    case 'getMediaState':
      // Média : la version C++ interroge chaque WebView2. Ici on annonce simplement 'aucun'.
      if (chromeView) chromeView.webContents.send('zaalis:message', { type: 'mediaState', available: false });
      break;
    case 'mediaCommand':
      // Best-effort : play/pause/next/prev via touches JS.
      break;
    case 'mediaState':
      // Passe-plat vers chrome.
      try {
        const parsed = JSON.parse(arg(0));
        if (chromeView) chromeView.webContents.send('zaalis:message', parsed);
      } catch {}
      break;
    default:
      // silencieux
      break;
  }
}

ipcMain.on('zaalis:postMessage', (event, str) => {
  if (typeof str !== 'string') return;
  const parts = str.split(SEP);
  handleAction(parts[0], parts.slice(1), event);
});

// ----- Fournir logo & pages via zaalis://home ------------------------------

function zaalisProtocolHandler(req) {
  const u = new URL(req.url);
  if (u.host !== 'home') return new Response('not found', { status: 404 });
  // Avatars de profil : servis depuis le dossier de donnees utilisateur.
  const av = u.pathname.match(/^\/+profile-avatar\/(p[a-z0-9]+)$/i);
  if (av) {
    const p = avatarPath(av[1]);
    if (!fs.existsSync(p)) return new Response('not found', { status: 404 });
    return new Response(fs.readFileSync(p), { headers: { 'content-type': 'image/png' } });
  }
  let file = u.pathname.replace(/^\/+/, '');
  if (file === '' || file === 'index.html') file = 'index.html';
  const filePath = file === 'logo-zaalis.png'
    ? path.join(__dirname, 'assets', 'logo-zaalis.png')
    : path.join(__dirname, 'interface', file);
  if (!fs.existsSync(filePath)) return new Response('not found', { status: 404 });
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.html' ? 'text/html; charset=utf-8'
    : ext === '.png' ? 'image/png'
    : ext === '.svg' ? 'image/svg+xml'
    : ext === '.js'  ? 'text/javascript'
    : ext === '.css' ? 'text/css'
    : 'application/octet-stream';
  const buf = fs.readFileSync(filePath);
  return new Response(buf, { headers: { 'content-type': mime } });
}

// Enregistre le handler sur la session par défaut ET sur la session persistée
// des onglets. Sans ça, les onglets (partition:'persist:zaalis-browser') ne
// voient pas le protocole et zaalis://home/* échoue.
function registerProtocol() {
  session.defaultSession.protocol.handle('zaalis', zaalisProtocolHandler);
  session.fromPartition('persist:zaalis-browser').protocol.handle('zaalis', zaalisProtocolHandler);
}

// Doit être appelé avant `app.whenReady()`.
protocol.registerSchemesAsPrivileged([{
  scheme: 'zaalis',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

// ----- API HTTP locale ------------------------------------------------------

function startApi() {
  const server = http.createServer((req, res) => {
    const parsed = url.parse(req.url, true);
    // Supporte /action et /zaalis/action (utilisé par zaalis labs ide).
    let path0 = parsed.pathname || '/';
    if (path0.startsWith('/zaalis/')) path0 = path0.slice(7);
    const q     = parsed.query   || {};
    const visible = q.visible !== '0';

    res.setHeader('access-control-allow-origin', '*');

    let action = null, value = '';
    if (path0 === '/ping')                        { res.end(JSON.stringify({ ok: true, name: 'zaalis browser' })); return; }
    if (path0 === '/search' || path0 === '/open') { action = path0.slice(1); value = q.q || q.url || ''; }
    else if (path0 === '/newtab')                 { action = 'newtab'; value = q.url || q.q || ''; }
    else if (path0 === '/')                       { res.end('zaalis browser api'); return; }

    if (!action) { res.statusCode = 404; res.end('no'); return; }

    if (mainWin) {
      if (action === 'search' || action === 'open') navigateActive(resolveQuery(value));
      else if (action === 'newtab')                 createTab(value ? resolveQuery(value) : '', true);
      if (visible) {
        mainWin.show();
        mainWin.focus();
        app.focus({ steal: true });
      }
    }
    res.end(JSON.stringify({ ok: true }));
  });
  server.on('error', (e) => { /* port occupé — on ignore */ });
  server.listen(API_PORT, '127.0.0.1');
}

// ----- Fenêtre principale ---------------------------------------------------

function createWindow() {
  const iconPath = path.join(__dirname, 'assets', 'logo-zaalis.png');
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;

  mainWin = new BaseWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: settings.theme === 'dark' ? '#202124' : '#e9eaed',
    icon,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
  });

  chromeView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-chrome.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  chromeView.setBackgroundColor('#00000000');
  mainWin.contentView.addChildView(chromeView);

  chromeView.webContents.on('did-finish-load', () => {
    // Décale la brand à droite pour ne pas passer sous les traffic lights macOS.
    chromeView.webContents.insertCSS(`
      .tabstrip { padding-left: 82px !important; }
      .brand    { padding-left: 0 !important; }
    `);
    pushState();
  });
  chromeView.webContents.loadURL(CHROME_URL);

  mainWin.on('resize', layoutAll);
  mainWin.on('closed', () => { mainWin = null; });

  mainWin.once('ready-to-show', () => mainWin.show());
  mainWin.show();

  createTab('', true);
  layoutAll();
}

// ----- App lifecycle --------------------------------------------------------

app.setName('zaalis browser');

// Empêche une deuxième instance (l'API HTTP fait déjà foreground).
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  if (mainWin) { mainWin.show(); mainWin.focus(); }
});

app.whenReady().then(() => {
  ensureDataFolder();
  loadSettings();
  loadProfiles();
  loadProfileData();   // favoris/raccourcis/historique/lanceur du profil courant
  loadAiChats();
  startIdeStatusWatcher();
  registerProtocol();
  createWindow();
  startApi();
  ensureDesktopAlias();

  // Menu macOS minimal (rôles standard) + raccourcis.
  const template = [
    { role: 'appMenu' },
    { role: 'fileMenu' },
    { label: 'Édition', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut'  }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ]},
    { label: 'Navigation', submenu: [
      { label: 'Nouvel onglet',     accelerator: 'Cmd+T', click: () => createTab('', true) },
      { label: 'Fermer l\'onglet',  accelerator: 'Cmd+W', click: () => { const t = activeTab(); if (t) closeTab(t.id); } },
      { label: 'Actualiser',        accelerator: 'Cmd+R', click: () => { const t = activeTab(); if (t) t.view.webContents.reload(); } },
      { label: 'Focus barre',       accelerator: 'Cmd+L', click: () => { if (chromeView) chromeView.webContents.send('zaalis:message', { type: 'focusOmni' }); } },
      { label: 'Reculer',           accelerator: 'Cmd+Left',  click: () => { const t = activeTab(); if (t && t.view.webContents.navigationHistory.canGoBack())    t.view.webContents.navigationHistory.goBack(); } },
      { label: 'Avancer',           accelerator: 'Cmd+Right', click: () => { const t = activeTab(); if (t && t.view.webContents.navigationHistory.canGoForward()) t.view.webContents.navigationHistory.goForward(); } },
    ]},
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWin) createWindow();
});
