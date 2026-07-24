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
  protocol, net, session, nativeImage, dialog, systemPreferences
} = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const http = require('http');
const url  = require('url');
const crypto = require('crypto');

// ----- Constantes ------------------------------------------------------------

const HOME_URL   = 'zaalis://home/index.html';
const CHROME_URL = 'zaalis://home/chrome.html';
const PANEL_URL  = 'zaalis://home/panel.html';
const SEP        = '\x1f';
const API_PORT   = 8715;
const PANEL_WIDTH = 340;
// Au retour sur un onglet web laisse en arriere-plan, on revalide la page
// apres ce delai. Cela rend visibles les publications/deploiements recents
// sans vider la session (cookies, connexion et formulaires restent intacts).
const STALE_TAB_REFRESH_MS = 4000;

// ----- État global -----------------------------------------------------------

let mainWin        = null;
let chromeView     = null;
let panelView      = null;
let dataFolder     = null;

const tabs   = [];              // { id, view, loading }
let   active = -1;
let   nextId = 1;
let   splitPair = null;         // [idGauche, idDroite] — vue fractionnee (2 max)

// Les éléments Favoris / applications / profil ne vivent que sur l'accueil.
// Les pages externes démarrent donc juste après la barre d'onglets et d'outils.
const CHROME_COMPACT_HEIGHT = 95;
let chromeHeight = CHROME_COMPACT_HEIGHT;
let contentTop   = CHROME_COMPACT_HEIGHT;
let chromeOverlay = false;
let chromeOverlayRect = { left:0, top:0, right:0, bottom:0 };

let panelOpen = false;
let pendingPanelHistory = false;
let pendingPanelDownloads = false;
let panelLoaded = false;
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
  restoreTabs:    false,
  safeSearch:     false,
  httpsOnly:      false,   // force la mise a niveau http -> https quand possible
  safeBrowsing:   true,    // avertit sur les sites malveillants/hameconnage connus
  zoomPct:        100,
  aiProvider:     'codex',
  aiSubmodel:     'gpt-5.5',
  // Le modèle de conversation du mode vocal est volontairement séparé de la
  // recherche et du panneau IA : il ne s'affiche que dans ses réglages.
  voiceProvider:  'codex',
  voiceSubmodel:  'gpt-5.5',
  aiOverview:     true,
  aiConnectEnabled: true,
};

// Providers + sous-modeles disponibles pour la recherche/chat IA.
// Miroir du catalogue de zaalis labs ide (interface/script/state.js) : le
// navigateur envoie { model: provider, submodel } au serveur IDE local.
// Miroir fidèle du catalogue de zaalis labs ide (interface/script/state.js).
// « local » (Ollama) et « gguf » (llama.cpp) sont des listes ouvertes : leur
// contenu réel est récupéré en direct auprès du serveur IDE (voir
// refreshLocalModels + aiProvidersSnapshot), si bien qu'un modèle Ollama ou un
// fichier .gguf ajouté côté IDE apparaît automatiquement ici.
const AI_PROVIDERS = {
  codex:  { label: 'ChatGPT (OpenAI)',   submodels: ['gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna','gpt-5.5','gpt-5.4','gpt-5.4-mini','gpt-5.4-nano','gpt-5.2','gpt-5.1','o3-mini','o1','gpt-4o-mini','gpt-3.5-turbo','gpt-4'] },
  claude: { label: 'Claude (Anthropic)', submodels: ['claude-fable-5','claude-opus-4-8','claude-sonnet-5','claude-haiku-4-5'] },
  gemini: { label: 'Gemini (Google)',    submodels: ['gemini-3.5-flash','gemini-3.1-pro-preview','gemini-3.1-flash-lite','gemini-3-flash-preview','gemini-2.5-pro','gemini-2.5-flash','gemini-2.5-flash-lite'] },
  grok:   { label: 'Grok (xAI)',         submodels: ['grok-4.5','grok-4.3','grok-4.20-multi-agent-0309','grok-4.20-0309-reasoning','grok-4.20-0309-non-reasoning','grok-build-0.1','grok-imagine-image-quality','grok-imagine-image'] },
  mistral:{ label: 'Mistral',            submodels: ['mistral-medium-3-5','mistral-small-latest','mistral-large-latest','ministral-14b-2512','ministral-8b-2512','ministral-3b-2512','codestral-latest'] },
  kimi:   { label: 'Kimi (Moonshot AI)', submodels: ['kimi-k3','kimi-k2.7-code','kimi-k2.7-code-highspeed','kimi-k2.6'] },
  local:  { label: 'Local (Ollama)',     submodels: ['qwen3:8b','llama3.2','gemma3:4b','deepseek-r1:8b','qwen2.5-coder:7b'] },
  gguf:   { label: 'GGUF (llama.cpp)',   submodels: [] },
};
const AI_MODEL_LABELS = {
  'gpt-5.6-sol': 'GPT-5.6 Sol', 'gpt-5.6-terra': 'GPT-5.6 Terra', 'gpt-5.6-luna': 'GPT-5.6 Luna',
  'gpt-5.5': 'GPT-5.5', 'gpt-5.4': 'GPT-5.4', 'gpt-5.4-mini': 'GPT-5.4 mini', 'gpt-5.4-nano': 'GPT-5.4 nano',
  'gpt-5.2': 'GPT-5.2', 'gpt-5.1': 'GPT-5.1', 'o3-mini': 'o3-mini', 'o1': 'o1', 'gpt-4o-mini': 'GPT-4o mini',
  'gpt-3.5-turbo': 'GPT-3.5 Turbo', 'gpt-4': 'GPT-4',
  'claude-fable-5': 'Claude Fable 5', 'claude-opus-4-8': 'Claude Opus 4.8', 'claude-sonnet-5': 'Claude Sonnet 5',
  'claude-haiku-4-5': 'Claude Haiku 4.5',
  'gemini-3.5-flash': 'Gemini 3.5 Flash', 'gemini-3.1-pro-preview': 'Gemini 3.1 Pro Preview',
  'gemini-3.1-flash-lite': 'Gemini 3.1 Flash-Lite', 'gemini-3-flash-preview': 'Gemini 3 Flash Preview',
  'gemini-2.5-pro': 'Gemini 2.5 Pro', 'gemini-2.5-flash': 'Gemini 2.5 Flash', 'gemini-2.5-flash-lite': 'Gemini 2.5 Flash-Lite',
  'grok-4.5': 'Grok 4.5', 'grok-4.3': 'Grok 4.3', 'grok-4.20-multi-agent-0309': 'Grok 4.20 Multi-Agent',
  'grok-4.20-0309-reasoning': 'Grok 4.20 Reasoning', 'grok-4.20-0309-non-reasoning': 'Grok 4.20 Non-Reasoning',
  'grok-build-0.1': 'Grok Build 0.1', 'grok-imagine-image-quality': 'Grok Imagine Image Quality', 'grok-imagine-image': 'Grok Imagine Image',
  'mistral-medium-3-5': 'Mistral Medium 3.5', 'mistral-small-latest': 'Mistral Small 4',
  'mistral-large-latest': 'Mistral Large 3', 'ministral-14b-2512': 'Ministral 3 14B',
  'ministral-8b-2512': 'Ministral 3 8B', 'ministral-3b-2512': 'Ministral 3 3B', 'codestral-latest': 'Codestral 25.08',
  'kimi-k3': 'Kimi K3', 'kimi-k2.7-code': 'Kimi K2.7 Code',
  'kimi-k2.7-code-highspeed': 'Kimi K2.7 Code HighSpeed', 'kimi-k2.6': 'Kimi K2.6',
};
// Modèles locaux vivants récupérés du serveur IDE (Ollama installés + .gguf
// présents). Remplacent les valeurs par défaut ci-dessus dès qu'ils sont connus.
let liveOllamaModels = [];
let liveGgufModels = [];
// Instantané des fournisseurs pour le panneau : fusionne les listes vivantes
// local/gguf par-dessus le catalogue statique.
function aiProvidersSnapshot() {
  const out = {};
  for (const [k, p] of Object.entries(AI_PROVIDERS)) {
    let submodels = p.submodels;
    if (k === 'local' && liveOllamaModels.length) submodels = liveOllamaModels.slice();
    else if (k === 'gguf') submodels = liveGgufModels.slice();
    out[k] = { label: p.label, submodels };
  }
  return out;
}
function aiModelLabel() {
  return AI_MODEL_LABELS[settings.aiSubmodel] || settings.aiSubmodel ||
         (AI_PROVIDERS[settings.aiProvider] || {}).label || 'IA';
}
function validAiChoice(provider, submodel) {
  const p = AI_PROVIDERS[provider];
  if (!p) return false;
  // 'local' (Ollama) et 'gguf' (llama.cpp) acceptent n'importe quel modèle
  // installe : listes ouvertes alimentees en direct par le serveur IDE.
  return (provider === 'local' || provider === 'gguf') ? !!submodel : p.submodels.includes(submodel);
}

let bookmarks = [];   // { url, title }
let shortcuts = [];   // { url, title } — home page tiles
let history   = [];   // { url, title }

// ----- Lanceur d'applications (facon Google) --------------------------------
// Deux modes par profil : « travail » = grille preremplie d'apps Google (icones
// via favicon, non modifiable) ; « creatif » = raccourcis ajoutes/supprimes par
// l'utilisateur. Persiste par profil dans launcher.json.
// Icones officielles Google chargees EN DIRECT depuis gstatic (pas embarquees
// dans l'app -> usage nominatif comme une favicon, pas de redistribution).
// `icon` vide => repli favicon cote UI (les favicons de ces domaines sont deja
// correctes : YouTube, Gemini, Maps, Actualites...).
const GST = 'https://www.gstatic.com/images/branding/product/2x/';
const WORK_APPS = [
  { url: 'https://myaccount.google.com', title: 'Compte',     icon: GST + 'googleg_48dp.png' },
  { url: 'https://drive.google.com',     title: 'Drive',      icon: GST + 'drive_2020q4_48dp.png' },
  { url: 'https://mail.google.com',      title: 'Gmail',      icon: GST + 'gmail_2020q4_48dp.png' },
  { url: 'https://www.youtube.com',      title: 'YouTube',    icon: GST + 'youtube_48dp.png' },
  { url: 'https://gemini.google.com',    title: 'Gemini',     icon: '' },
  { url: 'https://maps.google.com',      title: 'Maps',       icon: '' },
  { url: 'https://www.google.com',       title: 'Recherche',  icon: GST + 'googleg_48dp.png' },
  { url: 'https://calendar.google.com',  title: 'Agenda',     icon: GST + 'calendar_2020q4_48dp.png' },
  { url: 'https://news.google.com',      title: 'Actualités', icon: '' },
  { url: 'https://photos.google.com',    title: 'Photos',     icon: GST + 'photos_48dp.png' },
  { url: 'https://meet.google.com',      title: 'Meet',       icon: GST + 'meet_2020q4_48dp.png' },
  { url: 'https://translate.google.com', title: 'Traduction', icon: 'https://ssl.gstatic.com/images/branding/product/2x/translate_24dp.png' },
  { url: 'https://docs.google.com',      title: 'Docs',       icon: GST + 'docs_2020q4_48dp.png' },
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
  // Auto-réparation : si profiles.json est absent ou corrompu mais que des
  // dossiers de profil subsistent sur disque, on reconstruit les entrées
  // manquantes. Un profil (et ses favoris/historique) ne peut donc jamais
  // « disparaître » à cause d'un simple fichier d'index perdu.
  try {
    const base = path.join(dataFolder, 'profiles');
    const dirs = fs.existsSync(base)
      ? fs.readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
      : [];
    let recovered = false;
    for (const id of dirs) {
      if (profiles.some(p => p.id === id)) continue;
      profiles.push({
        id, name: 'Profil récupéré ' + (profiles.length + 1),
        color: PROFILE_COLORS[profiles.length % PROFILE_COLORS.length], photo: 0,
      });
      recovered = true;
    }
    if (recovered) saveProfiles();
  } catch {}
  if (currentProfileId && !profiles.some(p => p.id === currentProfileId)) currentProfileId = '';
}

// Écriture atomique : on écrit dans un fichier temporaire puis on renomme, afin
// qu'un crash en plein milieu ne laisse jamais un profiles.json vide (0 octet).
function saveProfiles() {
  try {
    const f = profilesFile(), tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(profiles), 'utf8');
    fs.renameSync(tmp, f);
  } catch {}
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
  saveOpenTabsNow();             // conserve les onglets du profil quitté
  profiles.push(p);
  currentProfileId = p.id;
  saveProfiles();
  saveSettings();
  refreshAfterProfileSwitch();   // nouveau profil = donnees vierges, bien separees
}

function selectProfile(id) {
  if (id && !profileById(id)) return;
  if ((id || '') === currentProfileId) return;
  saveOpenTabsNow();             // conserve les onglets du profil quitté
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
  if (wasCurrent) saveOpenTabsNow();   // conserve les onglets avant repli sur l'invité
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

// ----- Session : onglets a restaurer ----------------------------------------
function sessionTabsFile() { return path.join(profileDataDir(), 'session-tabs.json'); }
let saveTabsTimer = null;
function tabUrlForSession(t) {
  if (t.incognito) return '';   // la navigation privée n'est jamais persistée
  try {
    const u = t.view.webContents.getURL() || '';
    return isInternal(u) ? '' : u;
  } catch { return ''; }
}
function saveOpenTabsNow() {
  if (!settings.restoreTabs) return;
  try {
    const urls = tabs.map(tabUrlForSession);
    fs.writeFileSync(sessionTabsFile(), JSON.stringify({ active, urls }), 'utf8');
  } catch {}
}
function scheduleSaveOpenTabs() {
  if (!settings.restoreTabs) return;
  if (saveTabsTimer) clearTimeout(saveTabsTimer);
  saveTabsTimer = setTimeout(() => { saveTabsTimer = null; saveOpenTabsNow(); }, 250);
}
function loadSessionTabs() {
  try {
    const d = JSON.parse(fs.readFileSync(sessionTabsFile(), 'utf8'));
    const urls = Array.isArray(d.urls) ? d.urls.map(u => String(u || '')).slice(0, 40) : [];
    return { active: Math.max(0, Math.min(urls.length - 1, parseInt(d.active, 10) || 0)), urls };
  } catch { return null; }
}
function clearSessionTabs() {
  try { fs.unlinkSync(sessionTabsFile()); } catch {}
}

// Recharge toutes les donnees liees au profil (favoris, raccourcis, historique,
// lanceur) depuis le dossier du profil courant.
function loadProfileData() {
  bookmarks = readTsv('bookmarks.tsv');
  shortcuts = readTsv('shortcuts.tsv');
  history   = readTsv('history.tsv');
  loadLauncher();
  loadDownloads();
}

// Applique un changement de profil : recharge les donnees, reconstruit les
// onglets sur la session isolee du profil, et rafraichit l'UI.
function refreshAfterProfileSwitch() {
  loadProfileData();
  rebuildTabsForProfile();
  pushState();
  pushShortcuts();
  pushPanelState();
  sendPanelHistory();
  pushDownloads();
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
      else if (k === 'restoreTabs')            settings.restoreTabs = v === '1';
      else if (k === 'safeSearch')             settings.safeSearch = v === '1';
      else if (k === 'httpsOnly')              settings.httpsOnly = v === '1';
      else if (k === 'safeBrowsing')           settings.safeBrowsing = v !== '0';
      else if (k === 'aiProvider' && AI_PROVIDERS[v]) settings.aiProvider = v;
      else if (k === 'aiSubmodel' && v)        settings.aiSubmodel = v;
      else if (k === 'voiceProvider' && AI_PROVIDERS[v]) settings.voiceProvider = v;
      else if (k === 'voiceSubmodel' && v)     settings.voiceSubmodel = v;
      else if (k === 'aiOverview')             settings.aiOverview = v !== '0';
      else if (k === 'aiConnectEnabled')       settings.aiConnectEnabled = v !== '0';
      else if (k === 'zoomPct')                settings.zoomPct = Math.max(67, Math.min(200, parseInt(v,10) || 100));
      else if (k === 'currentProfile')         currentProfileId = v || '';
    }
  }
  // Cohérence provider/sous-modèle (fichier édité à la main, ancienne version…).
  if (!validAiChoice(settings.aiProvider, settings.aiSubmodel)) {
    settings.aiSubmodel = AI_PROVIDERS[settings.aiProvider].submodels[0] || settings.aiSubmodel || 'gpt-5.5';
  }
  if (!validAiChoice(settings.voiceProvider, settings.voiceSubmodel)) {
    // Migration des réglages existants : le premier lancement vocal reprend
    // le modèle IA courant, puis conserve son propre choix.
    settings.voiceProvider = settings.aiProvider;
    settings.voiceSubmodel = settings.aiSubmodel;
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
    `restoreTabs=${settings.restoreTabs ? 1 : 0}`,
    `safeSearch=${settings.safeSearch ? 1 : 0}`,
    `httpsOnly=${settings.httpsOnly ? 1 : 0}`,
    `safeBrowsing=${settings.safeBrowsing ? 1 : 0}`,
    `aiProvider=${settings.aiProvider}`,
    `aiSubmodel=${settings.aiSubmodel}`,
    `voiceProvider=${settings.voiceProvider}`,
    `voiceSubmodel=${settings.voiceSubmodel}`,
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

function isAllowedInternalUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    return u.protocol === 'zaalis:' && u.host === 'home' && !u.username && !u.password;
  } catch { return false; }
}

function allowedPageUrl(raw, allowInternal) {
  try {
    const u = new URL(String(raw || '').trim());
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
    if (allowInternal && isAllowedInternalUrl(u.toString())) return u.toString();
  } catch {}
  return null;
}

function resolveQuery(q) {
  q = (q || '').trim();
  if (!q) return HOME_URL;
  if (isAllowedInternalUrl(q)) return q;
  // Les URL saisies ne peuvent ouvrir que des pages web. Les autres schémas
  // (javascript:, data:, file:, etc.) deviennent une recherche ordinaire.
  if (/^https?:\/\//i.test(q)) return httpsUpgrade(q);
  // localhost / IP / hôte avec port
  if (/^(localhost|(\d{1,3}\.){3}\d{1,3})(:\d+)?(\/|$|\?|#)/i.test(q)) return 'http://' + q;
  // Contient un point + un TLD >=2 lettres et pas d'espace -> URL directe.
  if (!q.includes(' ') && /^[^\s]+\.[a-z]{2,63}([\/?#].*)?$/i.test(q)) return httpsUpgrade('https://' + q);
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

// Valeurs de repli affichées avant le premier contact avec l'IDE. Dès que
// l'IDE répond, cette liste est remplacée par les voix réellement disponibles
// sur ce Mac, sans redémarrer le navigateur.

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
    // Le pont est vivant : rafraîchit la liste des modèles locaux installés.
    refreshLocalModels();
  } finally {
    ideStatusChecking = false;
  }
}

// Récupère en direct les modèles locaux installés côté IDE — tags Ollama et
// fichiers .gguf — pour que tout modèle ajouté apparaisse automatiquement dans
// le sélecteur du navigateur, sans redémarrage ni liste codée en dur.
async function refreshLocalModels() {
  let changed = false;
  const key = (a) => a.join('\0');
  try {
    const r = await ideProbe('/api/ollama-models', 2500, true);
    if (r && r.status === 200 && r.body && Array.isArray(r.body.models)) {
      const list = r.body.models.map((m) => String(m)).filter(Boolean);
      // Ollama joignable mais vide : on garde les valeurs par défaut (list vide
      // -> aiProvidersSnapshot retombe sur le catalogue statique).
      if (key(list) !== key(liveOllamaModels)) { liveOllamaModels = list; changed = true; }
    }
  } catch {}
  try {
    const r = await ideProbe('/api/gguf-models', 2500, true);
    if (r && r.status === 200 && r.body && Array.isArray(r.body.models)) {
      const list = r.body.models.map((m) => m && m.name).filter(Boolean).map(String);
      if (key(list) !== key(liveGgufModels)) { liveGgufModels = list; changed = true; }
    }
  } catch {}
  if (changed) pushPanelState();
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
async function ideChat({ message, systemPrompt, history: turns, timeoutMs, provider, submodel }) {
  const data = await idePost('/api/chat', {
    model: provider || settings.aiProvider,
    submodel: submodel || settings.aiSubmodel,
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
  // Le chat IA est un panneau ancré : la page garde sa place à gauche, comme
  // le panneau Claude, au lieu d'être simplement recouverte par le chat.
  const aiReservedWidth = Math.round(AI_PANEL_WIDTH * aiPanelProgress);
  const bodyWidth = Math.max(0, w - aiReservedWidth);

  // Vue fractionnee : si l'onglet actif fait partie de la paire, les deux
  // membres se partagent la largeur, colles bord a bord (aucune demarcation).
  const pair = currentSplitTabs();
  const half = Math.floor(bodyWidth / 2);
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
        width: isLeft ? half : Math.max(0, bodyWidth - half + 1),
        height: bodyHeight,
      });
      t.view.setVisible(true);
    } else if (!pair && i === active) {
      t.view.setBounds({ x: 0, y: bodyTop, width: bodyWidth, height: bodyHeight });
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
      aiPanelView.setBounds({
        x: Math.max(0, bodyWidth),
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
      pinned: !!t.pinned,
      incognito: !!t.incognito,
    })),
    incognito: !!(a && a.incognito),
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
    restoreTabs: settings.restoreTabs,
    safeSearch: settings.safeSearch,
    httpsOnly: settings.httpsOnly,
    safeBrowsing: settings.safeBrowsing,
    aiProvider: settings.aiProvider,
    aiSubmodel: settings.aiSubmodel,
    voiceProvider: settings.voiceProvider,
    voiceSubmodel: settings.voiceSubmodel,
    aiOverview: settings.aiOverview,
    aiProviders: aiProvidersSnapshot(),
    aiModelLabels: AI_MODEL_LABELS,
    aiConnectEnabled: settings.aiConnectEnabled,
    aiStatus: ideStatus,
    aiStatusMessage: ideStatusMessage,
    zoomPct: settings.zoomPct,
    historyCount: history.length,
    downloadCount: downloads.length,
    bookmarkCount: bookmarks.length,
    profile: {
      currentId: currentProfileId,
      current: currentProfile()
        ? (({ id, name, color, photo }) => ({ id, name, color, photo }))(currentProfile())
        : null,
      list: profiles.map(p => ({ id: p.id, name: p.name, color: p.color, photo: p.photo })),
    },
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

// ----- Telechargements ------------------------------------------------------
// Les fichiers partent directement dans ~/Telechargements (pas de boite de
// dialogue, comme Chrome). Chaque element vit dans `downloads` (le plus recent
// en tete) ; tant qu'il progresse, son DownloadItem est garde dans
// `liveDownloads` pour pouvoir l'annuler.

const DOWNLOAD_KEEP = 60;         // elements termines conserves sur disque
let downloads = [];               // { id, name, path, url, state, received, total, icon, startedAt }
const liveDownloads = new Map();  // id -> DownloadItem (uniquement en cours)
let downloadSeq = 0;
let downloadsPushTimer = null;

function downloadsFile() { return path.join(profileDataDir(), 'downloads.json'); }

function loadDownloads() {
  downloads = [];
  try {
    const d = JSON.parse(fs.readFileSync(downloadsFile(), 'utf8'));
    if (Array.isArray(d)) downloads = d.filter(x => x && x.id && x.name).slice(0, DOWNLOAD_KEEP);
  } catch {}
  // Anciennes entrees sans icone (ou fichier remplace) : on la relit du systeme.
  downloads.forEach(d => { if (!d.icon && d.path && fs.existsSync(d.path)) attachFileIcon(d); });
}

function saveDownloads() {
  // On ne persiste que les elements termines : un telechargement en cours n'a
  // aucun sens apres un redemarrage.
  const done = downloads.filter(d => d.state !== 'progressing').slice(0, DOWNLOAD_KEEP);
  try { fs.writeFileSync(downloadsFile(), JSON.stringify(done), 'utf8'); } catch {}
}

function downloadsPayload() {
  return downloads.map(d => ({
    id: d.id, name: d.name, path: d.path, url: d.url, state: d.state,
    received: d.received, total: d.total, icon: d.icon || '', startedAt: d.startedAt,
  }));
}

function pushDownloads() {
  const msg = { type: 'downloads', items: downloadsPayload() };
  if (chromeView) chromeView.webContents.send('zaalis:message', msg);
  if (panelView)  panelView.webContents.send('zaalis:message', msg);
}

// Les evenements `updated` arrivent tres souvent : on regroupe les envois.
function scheduleDownloadsPush() {
  if (downloadsPushTimer) return;
  downloadsPushTimer = setTimeout(() => { downloadsPushTimer = null; pushDownloads(); }, 120);
}

// ~/Telechargements/nom.zip -> nom-2.zip si le fichier existe deja.
function uniqueDownloadPath(dir, filename) {
  filename = path.basename(String(filename || '').replace(/[\\/]/g, '_')) || 'telechargement';
  const ext  = path.extname(filename);
  const base = path.basename(filename, ext);
  let p = path.join(dir, filename);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base}-${i}${ext}`);
  return p;
}

// Icone systeme du fichier (celle du Finder), en dataURL pour la webview.
function attachFileIcon(entry) {
  if (!entry.path) return;
  app.getFileIcon(entry.path, { size: 'normal' })
    .then(img => {
      if (!img || img.isEmpty()) return;
      entry.icon = img.toDataURL();
      // L'icone arrive apres coup : on reecrit le fichier pour la conserver.
      if (entry.state !== 'progressing') saveDownloads();
      scheduleDownloadsPush();
    })
    .catch(() => {});
}

function downloadById(id) { return downloads.find(d => d.id === id) || null; }

function attachDownloads(ses) {
  ses.on('will-download', (_e, item) => {
    const id = 'd' + Date.now() + '-' + (++downloadSeq);
    const dir = app.getPath('downloads');
    let savePath = '';
    try {
      fs.mkdirSync(dir, { recursive: true });
      savePath = uniqueDownloadPath(dir, item.getFilename());
      item.setSavePath(savePath);
    } catch { savePath = ''; }

    const entry = {
      id,
      name: savePath ? path.basename(savePath) : item.getFilename(),
      path: savePath,
      url: item.getURL(),
      state: 'progressing',
      received: 0,
      total: item.getTotalBytes() || 0,
      icon: '',
      startedAt: Date.now(),
    };
    downloads.unshift(entry);
    liveDownloads.set(id, item);
    pushDownloads();

    item.on('updated', (__e, state) => {
      entry.received = item.getReceivedBytes();
      entry.total    = item.getTotalBytes() || entry.total;
      entry.state    = state === 'interrupted' ? 'interrupted' : 'progressing';
      if (!entry.icon) attachFileIcon(entry);
      scheduleDownloadsPush();
    });

    item.once('done', (__e, state) => {
      liveDownloads.delete(id);
      entry.received = item.getReceivedBytes();
      entry.total    = item.getTotalBytes() || entry.received;
      entry.state    = state === 'completed' ? 'completed'
                     : state === 'cancelled' ? 'cancelled' : 'interrupted';
      if (entry.state === 'completed') attachFileIcon(entry);
      saveDownloads();
      pushDownloads();
    });
  });
}

/* =============================================================================
 *  Sessions : isolation par profil + navigation privée + permissions par site
 * ========================================================================== */

const INCOGNITO_PARTITION = 'zaalis-incognito';   // pas de "persist:" => éphémère
const readyPartitions = new Set();

// Partition de la session pour l'onglet courant : chaque profil est réellement
// isolé (cookies/stockage séparés). L'invité garde la session historique.
function browserPartition() {
  return currentProfileId ? ('persist:zaalis-profile-' + currentProfileId)
                          : 'persist:zaalis-browser';
}

// Prépare une session (protocole zaalis://, téléchargements, permissions) une
// seule fois par partition. Idempotent : sûr à rappeler.
function setupSession(partition) {
  const ses = session.fromPartition(partition);
  if (readyPartitions.has(partition)) return ses;
  readyPartitions.add(partition);
  try { ses.protocol.handle('zaalis', zaalisProtocolHandler); } catch {}
  attachDownloads(ses);
  attachPermissions(ses, partition);
  return ses;
}

// ----- Permissions par site (caméra, micro, géoloc, notifications…) ---------
// Mémorisées par profil + origine dans permissions.json. L'incognito garde ses
// choix uniquement en mémoire. Une demande inconnue ouvre un dialogue natif.
let sitePermissions = {};        // "partition|origin|permission" -> allow|deny
const pendingPermPrompts = new Set();

const PERMISSION_LABELS = {
  media: 'utiliser votre caméra / micro',
  geolocation: 'accéder à votre position',
  notifications: 'afficher des notifications',
  midi: 'utiliser vos appareils MIDI',
  midiSysex: 'utiliser vos appareils MIDI (SysEx)',
  pointerLock: 'masquer le curseur',
  'clipboard-read': 'lire le presse-papiers',
  'display-capture': 'capturer votre écran',
};

function permissionsFile() { return path.join(dataFolder, 'permissions.json'); }
function loadSitePermissions() {
  try { const d = JSON.parse(fs.readFileSync(permissionsFile(), 'utf8')); sitePermissions = (d && typeof d === 'object') ? d : {}; }
  catch { sitePermissions = {}; }
}
function saveSitePermissions() {
  try { fs.writeFileSync(permissionsFile(), JSON.stringify(sitePermissions), 'utf8'); } catch {}
}
function originOf(u) { try { return new URL(u).origin; } catch { return ''; } }

function attachPermissions(ses, partition) {
  // L'incognito ne réutilise et ne persiste jamais une autorisation. Les
  // profils normaux disposent chacun de leur propre espace de décisions.
  const ephemeral = partition === INCOGNITO_PARTITION;
  const permissionStore = ephemeral ? Object.create(null) : sitePermissions;
  const permissionKey = (origin, permission) => partition + '|' + origin + '|' + permission;
  // Vérification synchrone (utilisée par certaines API) : suit la mémoire.
  // Le micro des pages internes (zaalis://home) sert au mode vocal : c'est
  // notre propre UI, pas un site — accord direct, sans dialogue site web.
  const internalMic = (origin, permission) =>
    (permission === 'media' || permission === 'audioCapture') &&
    String(origin || '').startsWith('zaalis://');
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    if (internalMic(requestingOrigin, permission)) return true;
    const key = permissionKey(requestingOrigin || '', permission);
    if (permissionStore[key] === 'allow') return true;
    if (permissionStore[key] === 'deny')  return false;
    // Autorise d'office les permissions non sensibles courantes.
    return ['fullscreen', 'clipboard-sanitized-write', 'pointerLock'].includes(permission);
  });

  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const origin = originOf(details && (details.requestingUrl || '')) || '';
    if (internalMic(origin, permission)) return callback(true);
    // Non sensible : accord direct (comportement navigateur classique).
    if (['fullscreen', 'clipboard-sanitized-write', 'pointerLock'].includes(permission)) return callback(true);
    const key = permissionKey(origin, permission);
    if (permissionStore[key] === 'allow') return callback(true);
    if (permissionStore[key] === 'deny')  return callback(false);
    if (!mainWin || !origin) return callback(false);
    // Évite d'empiler plusieurs dialogues identiques.
    if (pendingPermPrompts.has(key)) return callback(false);
    pendingPermPrompts.add(key);
    const what = PERMISSION_LABELS[permission] || ('utiliser : ' + permission);
    dialog.showMessageBox(mainWin, {
      type: 'question',
      buttons: ['Bloquer', 'Autoriser'],
      defaultId: 0, cancelId: 0,
      message: origin + '\nsouhaite ' + what + '.',
      detail: 'Votre choix sera mémorisé pour ce site.',
    }).then(r => {
      pendingPermPrompts.delete(key);
      const allow = r.response === 1;
      permissionStore[key] = allow ? 'allow' : 'deny';
      if (!ephemeral) saveSitePermissions();
      callback(allow);
    }).catch(() => { pendingPermPrompts.delete(key); callback(false); });
  });
}

// ----- Informations du site / cookies (popup de la barre d'adresse) --------

function siteInfoForActiveTab() {
  const tab = activeTab();
  const wc = tab && tab.view && tab.view.webContents;
  const pageUrl = wc && !wc.isDestroyed() ? wc.getURL() : '';
  let parsed;
  try { parsed = new URL(pageUrl); } catch { return Promise.resolve({ available: false }); }
  if (!/^https?:$/.test(parsed.protocol)) return Promise.resolve({ available: false });

  const origin = parsed.origin;
  const partition = tab.incognito ? INCOGNITO_PARTITION : browserPartition();
  const prefix = partition + '|' + origin + '|';
  const permissions = Object.entries(tab.incognito ? {} : sitePermissions)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, value]) => ({ permission: key.slice(prefix.length), value }))
    .filter(x => x.value === 'allow' || x.value === 'deny');

  return wc.session.cookies.get({ url: pageUrl }).then(cookies => ({
    available: true,
    origin,
    host: parsed.hostname,
    secure: parsed.protocol === 'https:',
    incognito: !!tab.incognito,
    cookies: cookies.map(c => ({
      name: String(c.name || ''), domain: String(c.domain || parsed.hostname),
      path: String(c.path || '/'), secure: !!c.secure, httpOnly: !!c.httpOnly,
      session: !!c.session, sameSite: String(c.sameSite || 'unspecified'),
    })),
    permissions,
  })).catch(() => ({ available: true, origin, host: parsed.hostname,
    secure: parsed.protocol === 'https:', incognito: !!tab.incognito, cookies: [], permissions }));
}

function sendSiteInfo(sender) {
  if (!sender || sender.isDestroyed()) return;
  siteInfoForActiveTab().then(info => {
    try { sender.send('zaalis:message', { type: 'siteInfo', info }); } catch {}
  });
}

function clearActiveSiteData(sender) {
  const tab = activeTab();
  const wc = tab && tab.view && tab.view.webContents;
  let origin = '';
  try { origin = new URL(wc.getURL()).origin; } catch {}
  if (!wc || !origin || origin === 'null') return;
  wc.session.clearStorageData({
    origin,
    storages: ['cookies', 'filesystem', 'indexdb', 'localstorage', 'websql', 'serviceworkers', 'cachestorage'],
  }).then(() => {
    try { sender.send('zaalis:message', { type: 'toast', text: 'Cookies et données du site effacés.' }); } catch {}
    sendSiteInfo(sender);
  }).catch(() => {
    try { sender.send('zaalis:message', { type: 'toast', text: 'Impossible d’effacer les données de ce site.' }); } catch {}
  });
}

function resetActiveSitePermissions(sender) {
  const tab = activeTab();
  const wc = tab && tab.view && tab.view.webContents;
  let origin = '';
  try { origin = new URL(wc.getURL()).origin; } catch {}
  if (!wc || !origin || origin === 'null') return;
  if (!tab.incognito) {
    const prefix = browserPartition() + '|' + origin + '|';
    for (const key of Object.keys(sitePermissions)) if (key.startsWith(prefix)) delete sitePermissions[key];
    saveSitePermissions();
  }
  try { sender.send('zaalis:message', { type: 'toast', text: 'Autorisations de ce site réinitialisées.' }); } catch {}
  sendSiteInfo(sender);
}

// ----- Safe Browsing léger (hors-ligne) -------------------------------------
// Heuristiques + petite liste locale : avertit sans dépendre d'un service tiers.
const SAFE_BROWSING_BLOCKLIST = [
  // domaines de démonstration/hameçonnage notoires (test)
  'testsafebrowsing.appspot.com',
  'malware.testing.google.test',
];
function safeBrowsingVerdict(u) {
  if (!settings.safeBrowsing) return null;
  let host = '';
  try { host = new URL(u).hostname.toLowerCase(); } catch { return null; }
  if (!host) return null;
  for (const bad of SAFE_BROWSING_BLOCKLIST) {
    if (host === bad || host.endsWith('.' + bad)) return 'Ce site figure sur une liste de sites dangereux connus.';
  }
  // Heuristique : nom d'hôte en punycode imitant une marque (homographe).
  if (/(^|\.)xn--/.test(host) && /(paypal|google|apple|microsoft|amazon|bank|coinbase)/i.test(u)) {
    return 'L\'adresse de ce site utilise des caractères trompeurs (risque d\'hameçonnage).';
  }
  return null;
}

// Interstitiel Safe Browsing : page d'avertissement avec « Retour » / « Continuer ».
function safeBrowsingInterstitial(u, reason) {
  const safe = String(u).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root{color-scheme:dark}
    body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
      font-family:-apple-system,"Segoe UI",Arial,sans-serif;background:#8b1a1a;color:#fff}
    .box{max-width:520px;padding:34px;text-align:center}
    .ic{font-size:52px;margin-bottom:12px}
    h1{font-size:22px;margin:0 0 10px} p{opacity:.92;line-height:1.5;font-size:14px}
    .u{font-size:12px;opacity:.7;word-break:break-all;margin-top:10px}
    .row{margin-top:22px;display:flex;gap:10px;justify-content:center}
    button{border:0;border-radius:10px;padding:10px 18px;font-size:13.5px;font-weight:600;cursor:pointer}
    .back{background:#fff;color:#8b1a1a}.go{background:transparent;color:#fff;border:1px solid rgba(255,255,255,.6)}
  </style></head><body><div class="box">
    <div class="ic">⚠️</div>
    <h1>Site potentiellement dangereux</h1>
    <p>${reason.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p>
    <div class="u">${safe}</div>
    <div class="row">
      <button class="back" id="back">Retour en sécurité</button>
      <button class="go" id="go">Continuer quand même</button>
    </div>
  </div><script>
    const destination=${JSON.stringify(String(u))};
    document.getElementById('back').onclick=()=>history.length>1?history.back():location.href=${JSON.stringify(HOME_URL)};
    document.getElementById('go').onclick=()=>location.href=destination;
  <\/script></body></html>`;
}

// Mise à niveau http -> https quand HTTPS-Only est actif (hors hôtes locaux et
// hôtes qui ont explicitement échoué en https, mémorisés le temps de la session).
const httpsExceptions = new Set();
function httpsUpgrade(u) {
  if (!settings.httpsOnly) return u;
  try {
    const x = new URL(u);
    if (x.protocol === 'http:' &&
        !/^(localhost|127\.|10\.|192\.168\.|0\.0\.0\.0|\[)/.test(x.hostname) &&
        !httpsExceptions.has(x.hostname)) {
      x.protocol = 'https:';
      return x.toString();
    }
  } catch {}
  return u;
}

// Ouvre l'ecran "Telechargements" du panneau. Si le panneau vient d'etre cree,
// sa page n'est pas encore prete : on rejoue la demande sur `panelReady`.
function showPanelDownloads() {
  if (!panelView || !panelLoaded) { pendingPanelDownloads = true; return; }
  panelView.webContents.send('zaalis:message', { type: 'showDownloads', items: downloadsPayload() });
}

function cancelDownload(id) {
  const item = liveDownloads.get(id);
  if (item) { try { item.cancel(); } catch {} return; }
  // Deja termine cote systeme : on marque quand meme l'entree comme annulee.
  const d = downloadById(id);
  if (d && d.state === 'progressing') { d.state = 'cancelled'; saveDownloads(); pushDownloads(); }
}

function showDownload(id) {
  const d = downloadById(id);
  if (d && d.path && fs.existsSync(d.path)) shell.showItemInFolder(d.path);
}

function openDownload(id) {
  const d = downloadById(id);
  if (d && d.state === 'completed' && d.path && fs.existsSync(d.path)) shell.openPath(d.path);
}

function removeDownload(id) {
  const d = downloadById(id);
  if (!d || d.state === 'progressing') return;   // on annule avant de retirer
  downloads = downloads.filter(x => x.id !== id);
  saveDownloads();
  pushDownloads();
}

function clearDownloads() {
  downloads = downloads.filter(d => d.state === 'progressing');
  saveDownloads();
  pushDownloads();
}

// ----- Onglets --------------------------------------------------------------

function applyWebSettings(view) {
  const wc = view.webContents;
  wc.setZoomFactor(settings.zoomPct / 100);
  wc.setAudioMuted(false);
}

function isWebPageUrl(u) {
  return /^https?:\/\//i.test(String(u || ''));
}

// `reload()` respecte le cache HTTP. Pour un navigateur de travail, le bouton
// d'actualisation et le retour vers un onglet ancien doivent au contraire
// revalider la ressource aupres du serveur : Electron fournit exactement cette
// semantique avec reloadIgnoringCache().
function reloadFresh(wc) {
  if (!wc || wc.isDestroyed()) return;
  try { wc.reloadIgnoringCache(); } catch {}
}

function createTab(rawUrl, activate, opts) {
  opts = opts || {};
  const incognito = !!opts.incognito;
  const preload = path.join(__dirname, 'preload-content.js');
  const partition = incognito ? INCOGNITO_PARTITION : browserPartition();
  setupSession(partition);   // protocole zaalis:// + téléchargements + permissions
  const view = new WebContentsView({
    webPreferences: {
      preload,
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: true,
      // Les WebContentsView invisibles sont sinon mis en veille : les apps
      // Google et les tableaux de bord ne recoivent plus leurs mises a jour
      // temps reel tant que l'onglet est cache.
      backgroundThrottling: false,
    },
  });
  view.setBackgroundColor('#00000000');

  const tab = {
    id: nextId++, view, loading: false, consoleBuf: [], pinned: false, incognito,
    loadedOnce: false, lastBackgroundAt: 0, lastFreshReloadAt: 0,
  };
  tabs.push(tab);

  const wc = view.webContents;

  // Capture des messages console de la page (tampon circulaire) pour que
  // l'assistant IA puisse les inspecter, comme l'extension Claude dans Chrome.
  wc.on('console-message', (_e, level, message, line, sourceId) => {
    try {
      const lv = ['log', 'info', 'warn', 'error'][level] || 'log';
      const src = sourceId ? String(sourceId).split('/').pop() : '';
      tab.consoleBuf.push({ level: lv, message: String(message).slice(0, 600), source: src, line });
      if (tab.consoleBuf.length > 200) tab.consoleBuf.shift();
    } catch {}
  });

  // Popups -> nouvel onglet
  wc.setWindowOpenHandler(({ url }) => {
    if (settings.blockPopups) return { action: 'deny' };
    const target = allowedPageUrl(url, false);
    if (target) createTab(target, true);
    return { action: 'deny' };
  });

  wc.on('did-start-loading', () => { tab.loading = true;  pushState(); });
  wc.on('did-stop-loading',  () => { tab.loading = false; tab.loadedOnce = true; pushState(); });
  wc.on('page-title-updated',   () => pushState());
  wc.on('did-navigate',         (_e, u) => { tab.consoleBuf = []; pushHistory(u, wc.getTitle()); pushState(); scheduleSaveOpenTabs(); });
  wc.on('did-navigate-in-page', () => { pushState(); scheduleSaveOpenTabs(); });

  // Garde de navigation (liens/JS de la page) : Safe Browsing + mise à niveau HTTPS.
  wc.on('will-navigate', (event, targetUrl) => {
    const target = allowedPageUrl(targetUrl, isInternal(wc.getURL()));
    if (!target) { event.preventDefault(); return; }
    const verdict = safeBrowsingVerdict(targetUrl);
    if (verdict) {
      event.preventDefault();
      const html = safeBrowsingInterstitial(targetUrl, verdict);
      wc.loadURL('data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf8').toString('base64'));
      return;
    }
    const up = httpsUpgrade(targetUrl);
    if (up !== targetUrl) { event.preventDefault(); wc.loadURL(up); }
  });

  wc.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
    // -3 = ERR_ABORTED (navigation annulée par l'utilisateur ou redirigée)
    if (!isMainFrame || code === -3) return;
    // HTTPS-Only : si une mise à niveau https échoue, on retombe en http et on
    // mémorise l'exception pour ce site (évite une boucle).
    try {
      const fx = new URL(failedUrl);
      if (settings.httpsOnly && fx.protocol === 'https:' && !httpsExceptions.has(fx.hostname) &&
          [-200, -201, -202, -501, -105, -106, -118, -137, -101, -100, -324].includes(code)) {
        httpsExceptions.add(fx.hostname);
        fx.protocol = 'http:';
        wc.loadURL(fx.toString());
        return;
      }
    } catch {}
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
    if (!isInternal(wc.getURL())) {
      items.push({ label: 'Traduire la page en français', click: () => translatePage('français') });
    }
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
    items.push({ label: 'Actualiser', click: () => reloadFresh(wc) });
    items.push({ type: 'separator' });
    items.push({ label: tab.pinned ? 'Détacher l\'onglet' : 'Épingler l\'onglet', click: () => togglePinTab(tab.id) });
    items.push({ label: 'Installer comme application…', click: () => installAsApp(tab.id) });
    if (settings.devTools) {
      items.push({ type: 'separator' });
      items.push({ label: 'Inspecter l\'élément', click: () => wc.inspectElement(params.x, params.y) });
      items.push({ label: wc.isDevToolsOpened() ? 'Fermer les outils de développement' : 'Outils de développement',
                  accelerator: 'Alt+Cmd+I',
                  click: () => { wc.isDevToolsOpened() ? wc.closeDevTools() : wc.openDevTools({ mode: 'detach' }); } });
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
  // Les sites externes conservent leur propre contexte JavaScript et leurs
  // propres politiques de sécurité (notamment YouTube / Trusted Types).
  wc.on('dom-ready', () => { if (isInternal(wc.getURL())) injectTheme(); });

  applyWebSettings(view);
  mainWin.contentView.addChildView(view);

  // Insertion sous chromeView / panel dans le z-order (les added-last sont au-dessus).
  // On remonte chromeView et panelView après.
  if (chromeView) { mainWin.contentView.addChildView(chromeView); }
  if (panelView && panelOpen) { mainWin.contentView.addChildView(panelView); }
  if (aiPanelView && aiPanelOpen) { mainWin.contentView.addChildView(aiPanelView); }

  guardedLoad(wc, rawUrl && rawUrl.length ? resolveQuery(rawUrl) : HOME_URL);

  if (activate) selectTab(tab.id);
  else { layoutAll(); pushState(); scheduleSaveOpenTabs(); }
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
  items.push({ label: t.pinned ? 'Détacher l\'onglet' : 'Épingler l\'onglet', click: () => togglePinTab(id) });
  items.push({ label: 'Nouvel onglet', click: () => createTab('', true) });
  items.push({ label: 'Nouvel onglet privé', click: () => openIncognitoTab() });
  items.push({ label: 'Actualiser',    click: () => reloadFresh(t.view.webContents) });
  if (!isInternal(t.view.webContents.getURL())) {
    items.push({ label: 'Installer comme application…', click: () => installAsApp(id) });
  }
  items.push({ type: 'separator' });
  items.push({ label: 'Fermer l\'onglet', click: () => closeTab(id) });
  Menu.buildFromTemplate(items).popup();
}

function selectTab(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx < 0) return;
  const now = Date.now();
  const previous = activeTab();
  if (previous && previous.id !== id) previous.lastBackgroundAt = now;
  active = idx;
  layoutAll();
  const t = tabs[idx];
  try { t.view.webContents.focus(); } catch {}
  const asleepFor = t.lastBackgroundAt ? now - t.lastBackgroundAt : 0;
  // Ne recharge jamais une page interne, un chargement en cours, ni un onglet
  // qui vient juste d'etre affiche. On evite ainsi les boucles et les pertes
  // de saisie, tout en revalidant les sites publies pendant l'absence.
  if (t.loadedOnce && !t.loading && isWebPageUrl(t.view.webContents.getURL()) &&
      asleepFor >= STALE_TAB_REFRESH_MS && now - t.lastFreshReloadAt >= STALE_TAB_REFRESH_MS) {
    t.lastFreshReloadAt = now;
    reloadFresh(t.view.webContents);
  }
  pushState();
  scheduleSaveOpenTabs();
}

function closeTab(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx < 0) return;
  if (splitPair && splitPair.includes(id)) splitPair = null;  // dissout la vue fractionnee
  const t = tabs[idx];
  // Mémorise l'URL pour la réouverture (⌘⇧T), sauf pages internes / privées.
  try {
    const u = t.view.webContents.getURL();
    if (u && !t.incognito && !isInternal(u)) { closedTabs.push(u); if (closedTabs.length > 25) closedTabs.shift(); }
  } catch {}
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
  scheduleSaveOpenTabs();
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
  sortPinned();           // les onglets épinglés restent en tête de la barre
  makeSplitAdjacent();    // la paire fractionnee reste toujours collee
  layoutAll();
  pushState();
  scheduleSaveOpenTabs();
}

// Chargement filtré par Safe Browsing (barre d'adresse + ouverture d'onglet).
function guardedLoad(wc, u) {
  const target = allowedPageUrl(u, true);
  if (!target) return false;
  const verdict = safeBrowsingVerdict(target);
  if (verdict) {
    const html = safeBrowsingInterstitial(target, verdict);
    try { wc.loadURL('data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf8').toString('base64')); } catch {}
    return true;
  }
  try { wc.loadURL(target); return true; } catch { return false; }
}

function navigateActive(u) {
  const t = activeTab();
  if (!t) { createTab(u, true); return; }
  guardedLoad(t.view.webContents, u);
  scheduleSaveOpenTabs();
}

// ----- Épinglage / recherche / navigation privée / PWA ----------------------

// Ramène les onglets épinglés au début de la barre (ordre relatif conservé).
function sortPinned() {
  const activeId = activeTab() ? activeTab().id : -1;
  const pinned = tabs.filter(t => t.pinned);
  const rest   = tabs.filter(t => !t.pinned);
  tabs.length = 0;
  tabs.push(...pinned, ...rest);
  active = tabs.findIndex(t => t.id === activeId);
}

function togglePinTab(id) {
  const t = tabs.find(x => x.id === id);
  if (!t) return;
  t.pinned = !t.pinned;
  // Un onglet épinglé quitte toute vue fractionnée.
  if (t.pinned && splitPair && splitPair.includes(id)) splitPair = null;
  sortPinned();
  layoutAll();
  pushState();
  scheduleSaveOpenTabs();
}

// Onglet de navigation privée : session éphémère, rien n'est écrit sur disque.
// Ouvre une page d'accueil privée dédiée (pas la page d'accueil classique).
function openIncognitoTab() { createTab('zaalis://home/incognito.html', true, { incognito: true }); }

// Pile des onglets récemment fermés (URLs) pour ⌘⇧T, comme Chrome.
let closedTabs = [];
function reopenClosedTab() {
  const u = closedTabs.pop();
  if (u) createTab(u, true);
}

// Onglet suivant / précédent (cyclique), comme Ctrl+Tab.
function cycleTab(dir) {
  if (tabs.length < 2 || active < 0) return;
  const i = (active + dir + tabs.length) % tabs.length;
  selectTab(tabs[i].id);
}

// Aller à l'onglet N (⌘1..⌘8) ; ⌘9 = dernier onglet, comme Chrome.
function gotoTab(n) {
  if (!tabs.length) return;
  const idx = n >= 9 ? tabs.length - 1 : Math.min(n - 1, tabs.length - 1);
  if (tabs[idx]) selectTab(tabs[idx].id);
}

// Ouvre le panneau réglages directement sur l'écran Historique (⌘Y).
function openHistoryPanel() {
  openPanel();
  if (panelLoaded) sendPanelHistory(); else pendingPanelHistory = true;
}

// « Installer comme application » (PWA-lite) : ajoute le site au lanceur d'apps
// pour un lancement en un clic, comme une application installée.
function installAsApp(id) {
  const t = tabs.find(x => x.id === id) || activeTab();
  if (!t) return;
  const wc = t.view.webContents;
  const u = wc.getURL();
  if (isInternal(u)) return;
  const title = (wc.getTitle() || u).slice(0, 60);
  if (!launcherApps.some(a => a.url === u)) {
    launcherApps.push({ url: u, title });
    launcherApps = launcherApps.slice(0, 30);
    saveLauncher();
    pushState();
  }
  if (mainWin) dialog.showMessageBox(mainWin, {
    type: 'info', buttons: ['OK'],
    message: '« ' + title +' » est installée comme application.',
    detail: 'Retrouvez-la dans le lanceur d\'apps (mode Créatif).',
  }).catch(() => {});
}

// Sessions réellement isolées : à chaque bascule de profil, on repart sur les
// onglets propres au profil (chaque profil ayant sa propre session persistée).
function rebuildTabsForProfile() {
  if (!mainWin) return;
  for (const t of tabs) {
    try { mainWin.contentView.removeChildView(t.view); } catch {}
    try { t.view.webContents.close(); } catch {}
  }
  tabs.length = 0; active = -1; splitPair = null;
  const saved = settings.restoreTabs ? loadSessionTabs() : null;
  if (saved && saved.urls.length) {
    saved.urls.forEach((u, i) => createTab(u, i === 0));
    if (tabs[saved.active]) selectTab(tabs[saved.active].id);
  } else {
    createTab('', true);
  }
  layoutAll();
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
    if (!isInternal(tab.view.webContents.getURL())) continue;
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
    restoreTabs: false, safeSearch: false,
    aiProvider: 'codex', aiSubmodel: 'gpt-5.5',
    voiceProvider: 'codex', voiceSubmodel: 'gpt-5.5',
    aiOverview: true, zoomPct: 100,
  });
  clearSessionTabs();
  saveSettings();
  applyChromeTheme();
  for (const t of tabs) { try { t.view.webContents.setZoomFactor(1); } catch {} }
  pushState();
  pushPanelState();
}

// ----- Panneau --------------------------------------------------------------

function lockInternalView(wc, allowedUrl) {
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (event, target) => {
    try {
      const a = new URL(allowedUrl), b = new URL(target);
      if (a.protocol === b.protocol && a.host === b.host && a.pathname === b.pathname) return;
    } catch {}
    event.preventDefault();
  });
}

function ensurePanelView() {
  if (panelView) return;
  panelView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-chrome.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  panelView.setBackgroundColor('#00000000');
  lockInternalView(panelView.webContents, PANEL_URL);
  panelView.webContents.on('did-finish-load', () => {
    panelLoaded = true;
    pushPanelState();
    if (pendingPanelHistory) { sendPanelHistory(); pendingPanelHistory = false; }
    if (pendingPanelDownloads) { pendingPanelDownloads = false; showPanelDownloads(); }
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

function openPanel() {
  if (!panelOpen) togglePanel();
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
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  aiPanelView.setBackgroundColor('#00000000');
  lockInternalView(aiPanelView.webContents, 'zaalis://home/aichat.html');
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
// ----- Agent IA outillé (comme l'extension Claude dans Chrome) ---------------
// Le backend IDE ne renvoie que du texte : on donne à l'assistant la capacité
// d'INSPECTER et d'AGIR sur la page active via une boucle d'outils par protocole
// texte. Le modèle demande un outil (bloc json), le navigateur l'exécute sur la
// WebContents active, renvoie le résultat, et la boucle continue jusqu'à la
// réponse finale.

// Boucle d'agent bornée par les TOKENS, comme l'extension Claude dans Chrome :
// pas de plafond d'étapes arbitraire. Chaque étape = une action (lire, cliquer,
// remplir UN champ). On continue tant que le contexte ré-injecté reste sous le
// budget de tokens ; deux garde-fous n'existent que pour empêcher une boucle
// réellement infinie (jamais atteints en usage normal). L'autorisation d'agir
// n'est demandée qu'une fois par session.
const AGENT_HARD_CAP = 300;          // garde-fou anti-boucle infinie
const AGENT_TOKEN_BUDGET = 200000;   // limite réelle : tokens de contexte estimés (marge sûre pour tout modèle cloud)
// Estimation grossière ~4 caractères / token de tout ce qui est ré-injecté.
function agentTokenEstimate(sysPrompt, hist, next) {
  let chars = String(sysPrompt || '').length + String(next || '').length;
  for (const m of hist) chars += String((m && m.content) || '').length;
  return Math.ceil(chars / 4);
}
const TOOL_RESULT_MAX = 6000;   // taille max d'un résultat réinjecté au modèle
const A11Y_TREE_MAX = 5200;     // budget texte de l'arbre d'accessibilité

const AGENT_SYSTEM =
  'Tu es l\'assistant IA du navigateur zaalis (propulsé par zaalis labs ide). ' +
  'Tu peux INSPECTER et AGIR sur la page web actuellement ouverte dans l\'onglet actif, ' +
  'exactement comme l\'extension Claude dans Chrome : lire la structure de la page, la console, ' +
  'le réseau, exécuter du JavaScript, cliquer, remplir des champs et naviguer. ' +
  'L\'utilisateur te voit agir : un curseur animé montre chaque clic et chaque saisie.\n\n' +
  'Pour utiliser un outil, réponds UNIQUEMENT avec un bloc de code, sans aucun autre texte :\n' +
  '```zaalis-tool\n{"tool":"NOM","args":{ ... }}\n```\n' +
  'Exemples exacts : `{"tool":"fill","args":{"ref":"ref_12","value":"Texte"}}` et ' +
  '`{"tool":"execute_js","args":{"code":"return document.title"}}`. ' +
  'Ne lance jamais fill sans `ref` ou `selector` ni execute_js sans `code`.\n\n' +
  'Outils disponibles :\n' +
  '- read_page {"selector"?:"CSS"} : arbre d\'accessibilité de la page (ou d\'un élément) — ' +
  'chaque élément interactif porte une référence [ref_N] à réutiliser dans click/fill.\n' +
  '- read_console {} : lit les messages récents de la console (log/info/warn/error).\n' +
  '- read_network {} : liste les requêtes réseau récentes (nom, type, durée, taille).\n' +
  '- execute_js {"code":"..."} : exécute du JavaScript dans la page et renvoie le résultat ' +
  '(utilise `return`). C\'est l\'outil universel : lire le DOM, extraire des données, calculer, mesurer.\n' +
  '- click {"ref":"ref_N"} ou {"selector":"CSS"} ou {"text":"libellé"} : vrai clic souris natif.\n' +
  '- fill {"ref":"ref_N" ou "selector":"CSS", "value":"...", "enter"?:true} : clique le champ puis ' +
  'tape la valeur (frappe native, remplace le contenu) ; "enter":true valide avec la touche Entrée.\n' +
  '- navigate {"url":"..."} ou {"action":"back|forward|reload"} : navigue.\n\n' +
  'Règles :\n' +
  '1. Dès que tu as besoin d\'une donnée réelle de la page, appelle l\'outil — n\'invente jamais.\n' +
  '2. Avant click ou fill, appelle read_page pour connaître les refs actuels ; préfère toujours "ref" ' +
  '(les refs restent valides tant que la page ne change pas).\n' +
  '3. Un seul outil par message. Après avoir reçu le résultat, enchaîne ou conclus.\n' +
  '4. Quand tu as la réponse finale pour l\'utilisateur, réponds en français, clair et concis, ' +
  'SANS bloc zaalis-tool.';

// Détecte une demande d'outil dans la réponse du modèle. Accepte un bloc balisé
// ```zaalis-tool / ```json ou, à défaut, le premier objet JSON contenant "tool".
function parseToolCall(text) {
  const s = String(text || '');
  let candidate = null;
  let m = s.match(/```(?:zaalis-tool|json|tool)?\s*([\s\S]*?)```/i);
  if (m) candidate = m[1];
  if (!candidate) {
    const b = s.match(/\{[\s\S]*?"tool"[\s\S]*?\}/);
    if (b) candidate = b[0];
  }
  if (!candidate) return null;
  try {
    const o = JSON.parse(candidate.trim());
    if (o && typeof o.tool === 'string') {
      // Les fournisseurs ne suivent pas tous la même convention : certains
      // placent les paramètres dans `args`, d'autres les mettent directement
      // à la racine. L'ancien parseur jetait ces paramètres racine, transformant
      // par exemple un fill valide en `fill {}` puis déclenchait l'anti-boucle.
      const rootArgs = Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'tool' && k !== 'args'));
      const nestedArgs = o.args && typeof o.args === 'object' && !Array.isArray(o.args) ? o.args : {};
      return { tool: o.tool, args: { ...rootArgs, ...nestedArgs } };
    }
  } catch {}
  return null;
}

function toolLabel(call) {
  const a = call.args || {};
  switch (call.tool) {
    case 'read_page':    return a.selector ? ('Lecture de « ' + a.selector + ' »') : 'Lecture de la page';
    case 'read_console': return 'Lecture de la console';
    case 'read_network': return 'Analyse du réseau';
    case 'execute_js':   return 'Exécution de JavaScript';
    case 'click':        return 'Clic — ' + (a.text || a.ref || a.selector || '');
    case 'fill':         return 'Saisie dans ' + (a.ref || a.selector || 'un champ');
    case 'navigate':     return 'Navigation — ' + (a.url || a.action || '');
    default:             return 'Outil ' + call.tool;
  }
}

function clampResult(s) {
  s = String(s == null ? '' : s);
  return s.length > TOOL_RESULT_MAX ? s.slice(0, TOOL_RESULT_MAX) + '\n…(tronqué)' : s;
}

function waitLoad(wc, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); wc.removeListener('did-stop-loading', finish); resolve(); };
    const timer = setTimeout(finish, ms || 4000);
    wc.once('did-stop-loading', finish);
  });
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// ----- Vision & action « comme l'extension Claude dans Chrome » --------------
// Tout le code injecté par l'agent tourne dans un MONDE ISOLÉ (même DOM que la
// page, contexte JavaScript séparé) : la page ne peut ni voir ni altérer nos
// références d'éléments ou notre curseur — mêmes garanties que les content
// scripts d'extension Chrome. Seul execute_js reste dans le monde de la page.
const AGENT_WORLD_ID = 1013;
let aiControlTab = null;

function agentExec(wc, code) {
  return wc.executeJavaScriptInIsolatedWorld(AGENT_WORLD_ID, [{ code }], true);
}

// Halo de contrôle : injecté dans l'onglet piloté, jamais dans le panneau IA.
// Reproduit littéralement le halo de la recherche IA (même dégradé, même flou
// 14px, même opacité, même animation) — un rectangle plein flouté dont seul le
// pourtour reste visible via le masque, si bien que la fenêtre est cernée du
// même bandeau lumineux épais que la barre de recherche.
function setAiControlBorder(t, active) {
  const target = active ? t : aiControlTab;
  aiControlTab = active && t ? t : null;
  if (!target || !target.view || target.view.webContents.isDestroyed()) return Promise.resolve();

  const enabled = !!active;
  const code = `(() => {
    const borderId = 'zaalis-agent-control-border';
    const styleId = 'zaalis-agent-control-border-style';
    const current = document.getElementById(borderId);
    if (!${enabled}) {
      if (current) current.remove();
      const style = document.getElementById(styleId);
      if (style) style.remove();
      if (window.__zCur) {
        try { window.__zCur.root.remove(); } catch {}
        try { delete window.__zCur; } catch {}
      }
      return;
    }
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = '@keyframes zaalis-agent-border-flow { from { background-position:0% 50%; } to { background-position:200% 50%; } }';
      (document.head || document.documentElement).appendChild(style);
    }
    if (current) return;
    const border = document.createElement('div');
    border.id = borderId;
    border.setAttribute('aria-hidden', 'true');
    // Le masque doit être *fondu* (dégradé alpha), pas à bord franc : un masque
    // dur est appliqué après le filtre et redécouperait des bords nets, ce qui
    // « durcit » le halo. Ici chaque bord s'estompe vers l'intérieur, puis le
    // blur(14px) diffuse le tout — même brume exacte que la barre de recherche.
    const feather = 'linear-gradient(to right,transparent,#000 10px,transparent 40px),linear-gradient(to left,transparent,#000 10px,transparent 40px),linear-gradient(to bottom,transparent,#000 10px,transparent 40px),linear-gradient(to top,transparent,#000 10px,transparent 40px)';
    border.style.cssText = [
      'position:fixed', 'inset:-3px', 'z-index:2147483647', 'pointer-events:none',
      'opacity:.8', 'filter:blur(14px)',
      'background:linear-gradient(90deg,rgba(0,120,255,.85),rgba(0,212,255,.85),rgba(120,90,255,.85),rgba(0,212,255,.85),rgba(0,120,255,.85))',
      'background-size:200% 100%', 'animation:zaalis-agent-border-flow 7s linear infinite',
      '-webkit-mask:' + feather, 'mask:' + feather
    ].join(';');
    (document.body || document.documentElement).appendChild(border);
  })()`;
  return agentExec(target.view.webContents, code).catch(() => {});
}

// Arbre d'accessibilité de la page (rôles + libellés + refs), comme le
// read_page de l'extension Claude. Les refs [ref_N] sont stables pour la durée
// de vie du document (WeakMap élément→ref, Map ref→élément dans le monde isolé).
function a11ySnapshotJs(selector) {
  return `(() => {
  const sel = ${JSON.stringify(String(selector || ''))};
  let root = document.body;
  if (sel) { try { root = document.querySelector(sel); } catch { return { error: 'sélecteur invalide : ' + sel }; } }
  if (!root) return { error: sel ? ('sélecteur introuvable : ' + sel) : 'page sans <body>' };
  if (!window.__zRefs) window.__zRefs = { n: 0, byRef: new Map(), byEl: new WeakMap() };
  const R = window.__zRefs;
  const refFor = (el) => { let r = R.byEl.get(el); if (!r) { r = 'ref_' + (++R.n); R.byEl.set(el, r); R.byRef.set(r, el); } return r; };
  const clean = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const ARIA = new Set(['link','checkbox','radio','tab','menuitem','combobox','switch','slider','searchbox','textbox','option','menuitemcheckbox','menuitemradio','spinbutton']);
  const roleOf = (el) => {
    const t = el.tagName, ar = (el.getAttribute('role') || '').toLowerCase();
    if (t === 'A') return el.hasAttribute('href') ? 'link' : (ar === 'button' ? 'button' : null);
    if (t === 'BUTTON' || t === 'SUMMARY' || ar === 'button') return 'button';
    if (t === 'SELECT') return 'select';
    if (t === 'TEXTAREA') return 'textbox';
    if (t === 'INPUT') {
      const ty = (el.getAttribute('type') || 'text').toLowerCase();
      if (ty === 'hidden') return null;
      if (ty === 'button' || ty === 'submit' || ty === 'reset' || ty === 'image') return 'button';
      if (ty === 'checkbox') return 'checkbox';
      if (ty === 'radio') return 'radio';
      if (ty === 'range') return 'slider';
      return 'textbox';
    }
    if (ARIA.has(ar)) return ar;
    if (el.isContentEditable && (!el.parentElement || !el.parentElement.isContentEditable)) return 'textbox';
    if (el.hasAttribute('onclick')) return 'button';
    const ti = el.getAttribute('tabindex');
    if (ti != null && +ti >= 0 && t !== 'BODY') return 'button';
    return null;
  };
  const labelOf = (el) => {
    let s = el.getAttribute('aria-label') || '';
    if (!s) {
      const lb = el.getAttribute('aria-labelledby');
      if (lb) s = lb.split(/\\s+/).map((id) => { const n = document.getElementById(id); return n ? n.textContent : ''; }).join(' ');
    }
    if (!s && el.id) { try { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) s = l.innerText; } catch {} }
    // placeholder AVANT value : la valeur courante est affichée à part
    // (valeur: "…"), le libellé doit rester stable quand l'utilisateur tape.
    if (!s) s = el.innerText || el.placeholder || el.title || el.value || el.getAttribute('alt') || el.getAttribute('name') || '';
    return clean(s).slice(0, 80);
  };
  const MAX = ${A11Y_TREE_MAX};
  const lines = [];
  let used = 0, cut = false;
  const push = (depth, s) => {
    if (used >= MAX) { cut = true; return; }
    const line = '  '.repeat(Math.min(depth, 5)) + s;
    if (line === lines[lines.length - 1]) return;
    lines.push(line); used += line.length + 1;
  };
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG','CANVAS','VIDEO','AUDIO','IFRAME','OBJECT','EMBED','SLOT']);
  const STRUCT = new Set(['MAIN','NAV','HEADER','FOOTER','ASIDE','FORM','SECTION','ARTICLE','UL','OL','TABLE','DIALOG','FIELDSET']);
  const DEEP = 'a,button,input,select,textarea,summary,img,h1,h2,h3,h4,h5,h6,[role],[onclick],[tabindex],[contenteditable]';
  const walk = (node, depth) => {
    for (let c = node.firstChild; c && !cut; c = c.nextSibling) {
      if (c.nodeType === 3) { const tx = clean(c.nodeValue); if (tx.length > 1) push(depth, 'text "' + tx.slice(0, 160) + '"'); continue; }
      if (c.nodeType !== 1 || SKIP.has(c.tagName)) continue;
      if (!visible(c)) continue;
      const role = roleOf(c);
      if (role) {
        let s = role + ' "' + labelOf(c) + '" [' + refFor(c) + ']';
        if (role === 'textbox' || role === 'searchbox' || role === 'combobox' || role === 'spinbutton') {
          const v = clean('value' in c ? c.value : c.innerText); if (v) s += ' (valeur: "' + v.slice(0, 40) + '")';
        } else if (role === 'checkbox' || role === 'radio' || role === 'switch') {
          s += (c.checked || c.getAttribute('aria-checked') === 'true') ? ' (coché)' : ' (non coché)';
        } else if (role === 'select') {
          const o = c.selectedOptions && c.selectedOptions[0]; if (o) s += ' (choix: "' + clean(o.label || o.value).slice(0, 40) + '")';
        }
        push(depth, s);
        continue;
      }
      const t = c.tagName;
      if (t === 'H1' || t === 'H2' || t === 'H3' || t === 'H4' || t === 'H5' || t === 'H6') {
        const h = clean(c.innerText); if (h) push(depth, t.toLowerCase() + ' "' + h.slice(0, 120) + '"'); continue;
      }
      if (t === 'IMG') { const a = clean(c.getAttribute('alt')); if (a) push(depth, 'image "' + a.slice(0, 80) + '"'); continue; }
      if (!c.querySelector(DEEP)) { const tx = clean(c.innerText); if (tx.length > 1) push(depth, 'text "' + tx.slice(0, 200) + '"'); continue; }
      walk(c, STRUCT.has(t) ? depth + 1 : depth);
    }
  };
  walk(root, 0);
  return { title: document.title || '', url: location.href, tree: lines.join('\\n'), cut };
})()`;
}

// Résout la cible d'un click/fill (ref > selector > texte), la fait défiler au
// centre et renvoie ses coordonnées viewport (px CSS) + son rectangle pour le
// halo. L'élément résolu est mémorisé dans le monde isolé (window.__zTarget)
// pour que les étapes suivantes (sélection, vérification) visent le même nœud.
function resolveTargetJs(args) {
  return `(() => {
  const ref = ${JSON.stringify(String(args.ref || ''))};
  const sel = ${JSON.stringify(String(args.selector || ''))};
  const txt = ${JSON.stringify(String(args.text || '').toLowerCase())};
  let el = null;
  if (ref) {
    const R = window.__zRefs;
    el = R ? (R.byRef.get(ref) || null) : null;
    if (!el) return { error: 'référence inconnue : ' + ref + ' — appelle read_page pour obtenir les refs actuels' };
    if (!el.isConnected) return { error: ref + ' a disparu de la page — appelle read_page pour des refs à jour' };
  }
  if (!el && sel) { try { el = document.querySelector(sel); } catch { return { error: 'sélecteur invalide : ' + sel }; } }
  if (!el && txt) {
    el = [...document.querySelectorAll('a,button,[role=button],[role=link],input[type=submit],input[type=button],[onclick],summary,[tabindex]')]
      .find((n) => ((n.innerText || n.value || n.getAttribute('aria-label') || '').trim().toLowerCase()).includes(txt));
  }
  if (!el) return { error: 'élément introuvable' };
  try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); } catch { try { el.scrollIntoView(); } catch {} }
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return { error: 'élément invisible (taille nulle)' };
  window.__zTarget = el;
  const x = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 2);
  const y = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 2);
  const label = String(el.innerText || el.value || el.getAttribute('aria-label') || el.placeholder || el.tagName || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  return { x, y, rect: { l: r.left, t: r.top, w: r.width, h: r.height }, label };
})()`;
}

// Curseur agent visible : pointeur SVG au dégradé zaalis + pastille d'action +
// halo sur la cible + onde au clic. Construit sans innerHTML (compatible
// Trusted Types) et stylé via CSSOM (compatible CSP strictes). pointer-events:
// none partout : l'overlay ne peut jamais intercepter le vrai clic.
const AGENT_OVERLAY_JS = `(() => {
  if (window.__zCur && window.__zCur.root.isConnected) return;
  const NS = 'http://www.w3.org/2000/svg';
  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  const hl = document.createElement('div');
  hl.style.cssText = 'position:absolute;left:0;top:0;border:2px solid #4898ff;border-radius:10px;box-shadow:0 0 0 4px rgba(72,152,255,.28),0 0 18px rgba(0,255,255,.35);opacity:0;transition:opacity .25s;';
  const cur = document.createElement('div');
  cur.style.cssText = 'position:absolute;left:0;top:0;opacity:0;transform:translate(-60px,-60px);transition:transform .5s cubic-bezier(.3,.75,.3,1),opacity .25s;will-change:transform;filter:drop-shadow(0 2px 6px rgba(0,0,0,.45));';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '26'); svg.setAttribute('height', '26'); svg.setAttribute('viewBox', '0 0 24 24');
  const defs = document.createElementNS(NS, 'defs');
  const grad = document.createElementNS(NS, 'linearGradient');
  grad.setAttribute('id', 'zaalis-cursor-grad');
  grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0'); grad.setAttribute('x2', '1'); grad.setAttribute('y2', '1');
  const s1 = document.createElementNS(NS, 'stop'); s1.setAttribute('offset', '0'); s1.setAttribute('stop-color', '#4898ff');
  const s2 = document.createElementNS(NS, 'stop'); s2.setAttribute('offset', '1'); s2.setAttribute('stop-color', '#00ffff');
  grad.appendChild(s1); grad.appendChild(s2); defs.appendChild(grad); svg.appendChild(defs);
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', 'M5.5 2.2 L5.5 18.6 L9.6 14.9 L12.1 20.9 L14.9 19.7 L12.4 13.8 L18 13.2 Z');
  p.setAttribute('fill', 'url(#zaalis-cursor-grad)');
  p.setAttribute('stroke', '#fff'); p.setAttribute('stroke-width', '1.3'); p.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(p);
  const chip = document.createElement('div');
  chip.style.cssText = 'position:absolute;left:20px;top:24px;background:linear-gradient(90deg,#4898ff,#00d4ff);color:#fff;font:600 11px/1 -apple-system,BlinkMacSystemFont,sans-serif;padding:5px 10px;border-radius:999px;white-space:nowrap;box-shadow:0 3px 10px rgba(0,0,0,.3);';
  cur.appendChild(svg); cur.appendChild(chip);
  root.appendChild(hl); root.appendChild(cur);
  document.documentElement.appendChild(root);
  let lastX = Math.max(28, Math.round(innerWidth * .12));
  let lastY = Math.max(28, Math.round(innerHeight * .18));
  window.__zCur = {
    root, cur,
    hold(label) {
      if (!root.isConnected) document.documentElement.appendChild(root);
      chip.textContent = label || 'IA active';
      chip.style.display = '';
      cur.style.opacity = '1';
      cur.style.transform = 'translate(' + lastX + 'px,' + lastY + 'px)';
      hl.style.opacity = '0';
    },
    act(x, y, label, rect) {
      if (!root.isConnected) document.documentElement.appendChild(root);
      lastX = Math.round(x); lastY = Math.round(y);
      chip.textContent = label || '';
      chip.style.display = label ? '' : 'none';
      cur.style.opacity = '1';
      cur.style.transform = 'translate(' + lastX + 'px,' + lastY + 'px)';
      if (rect) {
        hl.style.left = (rect.l - 4) + 'px'; hl.style.top = (rect.t - 4) + 'px';
        hl.style.width = (rect.w + 8) + 'px'; hl.style.height = (rect.h + 8) + 'px';
        hl.style.opacity = '1';
      } else hl.style.opacity = '0';
    },
    pulse(x, y) {
      const c = document.createElement('div');
      c.style.cssText = 'position:absolute;width:14px;height:14px;border-radius:50%;border:2.5px solid #00e0ff;box-shadow:0 0 12px rgba(0,224,255,.8);opacity:.95;transform:translate(-50%,-50%) scale(.4);transition:transform .45s ease-out,opacity .45s ease-out;left:' + Math.round(x) + 'px;top:' + Math.round(y) + 'px;';
      root.appendChild(c);
      requestAnimationFrame(() => { c.style.transform = 'translate(-50%,-50%) scale(2.6)'; c.style.opacity = '0'; });
      setTimeout(() => { try { c.remove(); } catch {} }, 600);
    },
  };
})()`;

// Pendant une étape sans cible (lecture, réseau, réflexion…), le curseur reste
// visible exactement là où l'étape précédente l'a laissé. La prochaine action
// réutilise la transition de transform et glisse naturellement vers sa cible.
async function agentHoldCursor(wc, label) {
  try {
    await agentExec(wc, AGENT_OVERLAY_JS + ';window.__zCur.hold(' +
      JSON.stringify(String(label || 'IA active')) + ');');
  } catch {}
}

// Anime le curseur jusqu'à la cible (halo inclus) et attend la fin du trajet,
// puis émet l'onde de clic si demandé. Ne bloque jamais l'outil en cas d'échec
// d'affichage (page exotique) : l'action reste prioritaire sur le visuel.
async function agentShowAction(wc, pt, label, withPulse) {
  try {
    await agentExec(wc, AGENT_OVERLAY_JS + ';window.__zCur.act(' + Math.round(pt.x) + ',' + Math.round(pt.y) + ',' +
      JSON.stringify(String(label || '')) + ',' + JSON.stringify(pt.rect || null) + ');');
    await sleepMs(560);
    if (withPulse) await agentExec(wc, 'window.__zCur && window.__zCur.pulse(' + Math.round(pt.x) + ',' + Math.round(pt.y) + ');');
  } catch {}
}

// Vrai clic souris : sendInputEvent injecte des événements natifs (move, down,
// up) dans la WebContents — indiscernables d'un clic humain (hover, focus,
// :active se déclenchent). Coordonnées CSS → DIP via le facteur de zoom.
async function nativeClick(wc, xCss, yCss) {
  let z = 1;
  try { z = wc.getZoomFactor() || 1; } catch {}
  const x = Math.round(xCss * z), y = Math.round(yCss * z);
  wc.sendInputEvent({ type: 'mouseMove', x, y });
  await sleepMs(40);
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  await sleepMs(55);
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
}

// Frappe native d'une touche (ex. 'Return' pour valider un formulaire).
function nativeKeyTap(wc, keyCode) {
  wc.sendInputEvent({ type: 'keyDown', keyCode });
  wc.sendInputEvent({ type: 'char', keyCode });
  wc.sendInputEvent({ type: 'keyUp', keyCode });
}

// Sélectionne le contenu du champ ciblé pour que l'insertion native le remplace.
const FOCUS_SELECT_JS = `(() => {
  const el = window.__zTarget;
  if (!el || !el.isConnected) return { error: 'cible perdue' };
  try { el.focus({ preventScroll: true }); } catch {}
  try {
    if (typeof el.select === 'function' && 'value' in el) el.select();
    else if (el.isContentEditable) {
      const r = document.createRange(); r.selectNodeContents(el);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    }
  } catch {}
  return { ok: true };
})()`;

const READ_VALUE_JS = `(() => {
  const el = window.__zTarget;
  if (!el) return null;
  return 'value' in el ? String(el.value) : String(el.innerText || '');
})()`;

// Repli si la frappe native a été neutralisée (champ non focusable, framework
// atypique) : affectation via le setter natif du prototype (compatible React).
function legacyFillJs(value) {
  return `(() => {
  const el = window.__zTarget;
  if (!el || !el.isConnected) return { error: 'cible perdue' };
  const v = ${JSON.stringify(String(value))};
  try {
    if ('value' in el) {
      const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      if (d && d.set) d.set.call(el, v); else el.value = v;
    } else el.textContent = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } catch (e) { return { error: String(e && e.message || e) }; }
  return { ok: true };
})()`;
}

const DISPATCH_CHANGE_JS = `(() => {
  const el = window.__zTarget;
  if (el && el.isConnected) { try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch {} }
  return true;
})()`;

// Exécute un outil sur l'onglet actif et renvoie un résultat texte pour le modèle.
async function runAgentTool(t, tool, args) {
  if (!t) return 'Aucune page web active.';
  const wc = t.view.webContents;
  args = args || {};
  const J = (v) => JSON.stringify(v);

  switch (tool) {
    case 'read_page': {
      const r = await agentExec(wc, a11ySnapshotJs(args.selector));
      if (!r) return 'Page illisible pour le moment.';
      if (r.error) return r.error;
      return 'Titre : ' + r.title + '\nURL : ' + r.url + '\n\n' + (r.tree || '(page vide)') +
             (r.cut ? '\n…(arbre tronqué — précise "selector" pour zoomer sur une zone)' : '');
    }
    case 'read_console': {
      const buf = t.consoleBuf || [];
      if (!buf.length) return 'Console vide (aucun message capturé depuis le chargement de la page).';
      return buf.slice(-60).map(e => '[' + e.level + '] ' + e.message + (e.source ? ' (' + e.source + ':' + e.line + ')' : '')).join('\n');
    }
    case 'read_network': {
      const list = await wc.executeJavaScript(
        '(()=>{try{const nav=performance.getEntriesByType("navigation")[0];' +
        'const res=performance.getEntriesByType("resource").slice(-50).map(e=>({name:e.name,type:e.initiatorType,ms:Math.round(e.duration),size:e.transferSize||0}));' +
        'return{page:nav?{url:location.href,loadMs:Math.round(nav.duration)}:{url:location.href},resources:res};}catch(e){return{error:String(e&&e.message||e)};}})()', true);
      return clampResult(J(list));
    }
    case 'execute_js': {
      const code = String(args.code || '');
      if (!code.trim()) return 'Erreur : aucun code fourni.';
      const wrapped =
        '(async()=>{try{const __r=await (async()=>{' + code + '\n})();' +
        'return JSON.stringify(__r===undefined?"(ok, sans valeur de retour)":__r);}' +
        'catch(e){return JSON.stringify({__error:String(e&&e.message||e)});}})()';
      const raw = await wc.executeJavaScript(wrapped, true);
      return clampResult(raw);
    }
    case 'click': {
      if (!args.ref && !args.selector && !args.text) return 'Erreur : préciser "ref", "selector" ou "text".';
      const pt = await agentExec(wc, resolveTargetJs(args));
      if (!pt || pt.error) return J({ error: (pt && pt.error) || 'élément introuvable' });
      // On montre le geste (curseur + halo), puis on clique pour de vrai.
      await agentShowAction(wc, pt, 'Clic' + (pt.label ? ' — ' + pt.label.slice(0, 40) : ''), true);
      const before = wc.getURL();
      await nativeClick(wc, pt.x, pt.y);
      await sleepMs(450);
      const out = { ok: true, cliqué: pt.label || '(élément)' };
      if (wc.getURL() !== before) { await waitLoad(wc, 4000); out.navigation = wc.getURL(); }
      return J(out);
    }
    case 'fill': {
      if (!args.ref && !args.selector) return 'Erreur : "ref" ou "selector" requis.';
      const pt = await agentExec(wc, resolveTargetJs({ ref: args.ref, selector: args.selector }));
      if (!pt || pt.error) return J({ error: (pt && pt.error) || 'champ introuvable' });
      const value = String(args.value == null ? '' : args.value);
      await agentShowAction(wc, pt, 'Saisie — ' + (pt.label || 'champ').slice(0, 40), true);
      wc.focus();
      await nativeClick(wc, pt.x, pt.y);   // focus par vrai clic (handlers focus/click natifs)
      await sleepMs(140);
      await agentExec(wc, FOCUS_SELECT_JS);          // sélectionne l'existant…
      try { await wc.insertText(value); } catch {}   // …remplacé par une frappe native
      await sleepMs(90);
      // Vérifie la valeur obtenue ; au besoin repli sur l'affectation directe.
      let final = await agentExec(wc, READ_VALUE_JS);
      if (final !== value) {
        await agentExec(wc, legacyFillJs(value));
        final = await agentExec(wc, READ_VALUE_JS);
      }
      await agentExec(wc, DISPATCH_CHANGE_JS);
      if (args.enter) { await sleepMs(80); nativeKeyTap(wc, 'Return'); await sleepMs(400); await waitLoad(wc, 4000); }
      // Rend le clavier au panneau IA pour ne pas voler la saisie de l'utilisateur.
      if (aiPanelOpen && aiPanelView) { try { aiPanelView.webContents.focus(); } catch {} }
      return J({ ok: true, champ: pt.label || args.selector || args.ref || '',
                 valeur: String(final == null ? '' : final).slice(0, 120), entrée: !!args.enter });
    }
    case 'navigate': {
      if (args.action === 'back')    { if (wc.navigationHistory.canGoBack())    wc.navigationHistory.goBack();    else return 'Impossible de reculer.'; }
      else if (args.action === 'forward') { if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); else return 'Impossible d\'avancer.'; }
      else if (args.action === 'reload')  { wc.reload(); }
      else if (args.url) {
        let u = String(args.url).trim();
        if (!/^[a-z]+:\/\//i.test(u)) u = 'https://' + u;
        u = allowedPageUrl(u, false);
        if (!u) return 'Navigation refusée : seuls les liens http et https sont autorisés.';
        try { await wc.loadURL(u); } catch (e) { return 'Échec de navigation : ' + (e && e.message || e); }
      } else return 'Erreur : préciser "url" ou "action".';
      await waitLoad(wc, 5000);
      if (aiControlTab === t) await setAiControlBorder(t, true);
      return 'Page chargée : ' + wc.getURL();
    }
    default:
      return 'Outil inconnu : ' + tool;
  }
}

// Contexte rapide de la page active, injecté dans le prompt système à chaque tour.
async function quickPageContext(t) {
  if (!t) return '';
  try {
    const info = await t.view.webContents.executeJavaScript(
      '({title:document.title||"",url:location.href,text:(document.body&&document.body.innerText||"").replace(/\\s+/g," ").trim().slice(0,2500)})', true);
    return 'Titre : ' + (info.title || '(sans titre)') + '\nURL : ' + info.url +
           '\nAperçu du contenu :\n' + (info.text || '(vide)');
  } catch { return ''; }
}

function ideErrorReply(e) {
  const m = String(e && e.message || '');
  if (m.startsWith('no-key:')) return '⚠️ ' + m.slice(7) + '\nAjoute ta clé API dans zaalis labs ide (Paramètres → Clés API).';
  if (m === 'no-secret') return '⚠️ zaalis labs ide n\'a jamais été lancé sur ce Mac. Lance-le une première fois pour activer l\'IA.';
  if (m === 'timeout')   return '⚠️ Le modèle met trop de temps à répondre. Réessaie.';
  if (/too many|429|rate.?limit/i.test(m)) return '⚠️ Le fournisseur IA limite le débit (trop de requêtes rapprochées). Patiente quelques secondes puis réessaie.';
  return '⚠️ Impossible de joindre zaalis labs ide. Vérifie qu\'il est bien lancé, puis réessaie.';
}

async function aiChatSend(text, pageContext) {
  text = String(text || '').replace(/\x1f/g, ' ').trim();
  if (!text || aiChatBusy) return;
  let chat = aiChatById(aiCurrentChatId);
  if (!chat) chat = newAiChat(text.slice(0, 44));
  if (chat.messages.length === 0 && chat.title === 'Nouvelle conversation') chat.title = text.slice(0, 44);

  // Historique conversationnel (on écarte les étapes d'outils, non pertinentes
  // pour le modèle d'un tour à l'autre et parfois refusées par le serveur).
  const history = chat.messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, content: m.content }));
  chat.messages.push({ role: 'user', content: text });
  chat.updatedAt = new Date().toISOString();
  saveAiChats();
  aiChatBusy = true;
  pushAiChatMessages();
  pushAiChatList();

  const t = activeTab();
  let liveCtx = pageContext;
  if (!liveCtx && t) liveCtx = await quickPageContext(t);
  const sysPrompt = AGENT_SYSTEM + (liveCtx
    ? '\n\n--- Page actuellement ouverte ---\n' + liveCtx
    : '\n\n(Aucune page web active pour le moment.)');

  const loopHistory = history.slice();
  let nextMessage = text;
  let finalReply = null;
  let agentMutationApproved = false;

  let repeatKey = '', repeatCount = 0;
  for (let step = 0; step < AGENT_HARD_CAP; step++) {
    // Limite réelle = tokens : on s'arrête proprement avant de saturer le
    // contexte du modèle, plutôt que d'attendre une erreur d'API.
    if (agentTokenEstimate(sysPrompt, loopHistory, nextMessage) > AGENT_TOKEN_BUDGET) {
      finalReply = 'J\'ai atteint la limite de contexte (tokens) du modèle après avoir traité une grande partie de la tâche. Relance-moi pour poursuivre.';
      break;
    }
    // Un échec ponctuel (rate-limit du fournisseur, réseau) ne doit pas casser
    // toute la session d'agent : jusqu'à 3 tentatives avec pause adaptée
    // (les 429 « Too Many Requests » exigent de laisser la fenêtre se rouvrir).
    let out = null, lastErr = null;
    for (let attempt = 0; attempt < 3 && !out; attempt++) {
      try {
        out = await ideChat({ message: nextMessage, history: loopHistory, systemPrompt: sysPrompt, timeoutMs: 90000 });
      } catch (e) {
        lastErr = e;
        const m = String(e && e.message || '');
        if (m.startsWith('no-key:') || m === 'no-secret') break;
        if (attempt < 2) await sleepMs(/too many|429|rate.?limit/i.test(m) ? 12000 : 2500);
      }
    }
    if (!out) { finalReply = ideErrorReply(lastErr); break; }

    const resp = out.response;
    const call = t ? parseToolCall(resp) : null;
    if (!call) { finalReply = resp; break; }

    // Garde-fou anti-boucle : la même action répétée à l'identique plusieurs
    // fois d'affilée = blocage (le remplissage légitime vise des champs
    // différents, donc des args différents).
    const repeatK = call.tool + '|' + JSON.stringify(call.args || {});
    if (repeatK === repeatKey) {
      if (++repeatCount >= 4) { finalReply = 'Je répète la même action sans progresser, je m\'arrête pour éviter une boucle. Peux-tu préciser la demande ?'; break; }
    } else { repeatKey = repeatK; repeatCount = 0; }

    // Le modèle demande un outil : on l'exécute et on réinjecte le résultat.
    loopHistory.push({ role: 'user', content: nextMessage });
    loopHistory.push({ role: 'assistant', content: resp });

    const label = toolLabel(call);
    await setAiControlBorder(t, true);
    await agentHoldCursor(t.view.webContents, label);
    aiPanelSend({ type: 'aiChatStep', label });
    let result;
    const mutating = ['execute_js', 'click', 'fill', 'navigate'].includes(call.tool);
    if (mutating && !agentMutationApproved) {
      const choice = await dialog.showMessageBox(mainWin, {
        type: 'question',
        buttons: ['Annuler', 'Autoriser cette action'],
        defaultId: 0, cancelId: 0,
        message: 'L’assistant IA souhaite agir sur la page',
        detail: label + '\n\nLa page peut contenir des instructions trompeuses. Autorisez seulement si cette action correspond bien à votre demande.',
      });
      agentMutationApproved = choice.response === 1;
      if (!agentMutationApproved) result = 'Action refusée par l’utilisateur.';
    }
    try { if (result == null) result = await runAgentTool(t, call.tool, call.args); }
    catch (e) { result = 'Erreur outil : ' + (e && e.message || e); }

    chat.messages.push({ role: 'tool', tool: call.tool, label, content: clampResult(result).slice(0, 800) });
    chat.updatedAt = new Date().toISOString();
    saveAiChats();
    // Mise à jour INCRÉMENTALE (pas de re-render complet) : le panneau ajoute
    // la ligne au lot et fait glisser le compteur, sans reconstruire le chat.
    aiPanelSend({ type: 'aiChatAction', label });

    nextMessage = '[RÉSULTAT DE L\'OUTIL ' + call.tool + ']\n' + clampResult(result);
  }

  if (finalReply == null) finalReply = 'Je me suis arrêté après plusieurs étapes d\'analyse sans conclure. Peux-tu préciser ta demande ?';
  await setAiControlBorder(null, false);
  chat.messages.push({ role: 'assistant', content: finalReply });
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

// ----- Recherche vocale ------------------------------------------------------
// Le navigateur conserve l'orbe et la capture vocale, mais ne déclenche plus
// de conversation IA ni de synthèse : la phrase est transcrite localement par
// zaalis labs IDE puis devient immédiatement une recherche Web, façon recherche
// vocale Google. `voiceGen` annule un résultat devenu périmé à l'arrêt.
let voiceGen = 0;
let voiceWc = null;

function voiceSend(msg) {
  if (!voiceWc || voiceWc.isDestroyed()) return;
  try { voiceWc.send('zaalis:message', msg); } catch {}
}

async function voiceStart(sender) {
  voiceGen++;
  voiceWc = sender;
  if (ideStatus !== 'connected') {
    voiceSend({ type: 'voiceState', phase: 'error', message: ideStatusMessage || 'zaalis labs ide n\'est pas joignable.' });
    return;
  }
  // macOS : déclenche la demande d'accès micro système au nom de l'app.
  try { if (process.platform === 'darwin') await systemPreferences.askForMediaAccess('microphone'); } catch {}
  let st = null;
  try { st = (await ideProbe('/api/voice-status', 4000, true)).body; } catch {}
  if (!st || !st.stt || !st.stt.ready) {
    const hint = (st && st.stt && st.stt.hint) ||
      'La transcription vocale est indisponible (zaalis labs ide ne répond pas).';
    const dl = st && st.stt && st.stt.pull;
    voiceSend({ type: 'voiceState', phase: dl ? 'preparing' : 'error', message: hint });
    if (!dl) return;
    // Modèle en cours de téléchargement : la page ré-essaiera (bouton/retry).
  }
  voiceSend({ type: 'voiceState', phase: 'listening' });
}

function voiceStop() {
  voiceGen++;
  voiceWc = null;
}

// Un tour de recherche : audio utilisateur → texte → recherche Web.
async function voiceTurn(sender, audioB64) {
  const gen = ++voiceGen;      // ce tour remplace tout tour précédent
  voiceWc = sender;
  const alive = () => gen === voiceGen && voiceWc && !voiceWc.isDestroyed();
  try {
    voiceSend({ type: 'voiceState', phase: 'thinking' });
    let stt;
    try { stt = await idePost('/api/stt', { audio: audioB64, language: 'fr' }, 150000); }
    catch (e) {
      const m = String(e && e.message || '');
      if (!alive()) return;
      voiceSend({ type: 'voiceState', phase: m.includes('model-downloading') ? 'preparing' : 'error',
                  message: m.includes('model-downloading') ? 'Le modèle vocal se télécharge, un instant…'
                         : m.includes('speech-denied') ? 'Autorisez la reconnaissance vocale pour zaalis labs IDE dans les réglages macOS.'
                         : m.includes('stt-unavailable') ? 'Mettez à jour zaalis labs IDE pour activer la reconnaissance vocale.'
                         : ('Transcription impossible : ' + m) });
      return;
    }
    if (!alive()) return;
    const heard = String(stt.text || '').trim();
    // Rien d'intelligible (souffle, bruit) : on se remet à l'écoute.
    if (!heard || /^[\[(]/.test(heard)) { voiceSend({ type: 'voiceState', phase: 'listening' }); return; }
    voiceSend({ type: 'voiceState', phase: 'searching', transcript: heard,
                message: 'Recherche de « ' + heard + ' »' });
    // Court temps d'affichage de la transcription, puis ouverture du moteur
    // choisi. Aucun appel LLM/TTS n'est effectué dans ce flux.
    setTimeout(() => {
      if (!alive()) return;
      navigateActive(resolveQuery(heard));
      voiceGen++;
      voiceWc = null;
    }, 180);
  } catch (e) {
    if (gen === voiceGen) voiceSend({ type: 'voiceState', phase: 'error', message: String(e && e.message || e) });
  }
}

// ----- Traduction de page (via zaalis labs ide) -----------------------------
// Conçue sans risque : on extrait les segments de texte visibles, on les fait
// traduire par le modèle, puis on réinjecte. Au moindre échec, la page reste
// intacte (aucune modification n'est appliquée).
const TRANSLATE_EXTRACT_JS = `(() => {
  const skip = new Set(['SCRIPT','STYLE','NOSCRIPT','CODE','PRE','TEXTAREA','KBD','SAMP']);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(n){
      const v = n.nodeValue;
      if (!v || !v.trim() || v.trim().length < 2) return NodeFilter.FILTER_REJECT;
      const p = n.parentElement;
      if (!p || skip.has(p.tagName)) return NodeFilter.FILTER_REJECT;
      if (p.closest('[contenteditable="true"]')) return NodeFilter.FILTER_REJECT;
      const s = getComputedStyle(p);
      if (s && (s.display === 'none' || s.visibility === 'hidden')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const nodes = []; let n;
  while ((n = walker.nextNode())) nodes.push(n);
  window.__zTransNodes = nodes;
  return nodes.slice(0, 120).map((nd,i)=>({ i, t: nd.nodeValue.trim().slice(0,300) }));
})()`;

let translating = false;
async function translatePage(targetLang) {
  const t = activeTab();
  if (!t || translating) return;
  const wc = t.view.webContents;
  const lang = targetLang || 'français';
  let segs = [];
  try { segs = await wc.executeJavaScript(TRANSLATE_EXTRACT_JS, true); } catch { segs = []; }
  if (!Array.isArray(segs) || !segs.length) return;
  translating = true;
  if (chromeView) chromeView.webContents.send('zaalis:message', { type: 'toast', text: 'Traduction en cours…' });
  try {
    const payload = segs.map(s => s.i + '\t' + s.t).join('\n');
    const out = await ideChat({
      message: 'Traduis en ' + lang + ' chaque segment ci-dessous. Réponds UNIQUEMENT par un objet JSON ' +
               '{"index": "traduction"} sans autre texte. Conserve les nombres et noms propres.\n\n' + payload,
      systemPrompt: 'Tu es un moteur de traduction. Tu renvoies exclusivement du JSON valide.',
      timeoutMs: 90000,
    });
    const m = out.response.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no-json');
    const map = JSON.parse(m[0]);
    const clean = {};
    for (const k of Object.keys(map)) { const v = map[k]; if (typeof v === 'string') clean[String(parseInt(k, 10))] = v; }
    await wc.executeJavaScript(
      '(() => { const map = ' + JSON.stringify(clean) + '; const nodes = window.__zTransNodes || [];' +
      'let c=0; Object.keys(map).forEach(k => { const nd = nodes[+k]; if (nd && map[k]) { nd.nodeValue = map[k]; c++; } });' +
      'window.__zTransDone = true; return c; })()', true);
    if (chromeView) chromeView.webContents.send('zaalis:message', { type: 'toast', text: 'Page traduite.' });
  } catch (e) {
    const msg = String(e && e.message || '');
    const txt = msg.startsWith('no-secret') || msg.startsWith('no-key')
      ? 'Traduction indisponible : configure l\'IA dans zaalis labs ide.'
      : 'La traduction a échoué. Réessaie.';
    if (chromeView) chromeView.webContents.send('zaalis:message', { type: 'toast', text: txt });
  } finally {
    translating = false;
  }
}

// ----- Controle media -------------------------------------------------------

const MEDIA_STATE_JS = `(() => {
  const all = Array.from(document.querySelectorAll('video,audio'));
  const scored = all.map(el => {
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
    const duration = Number.isFinite(el.duration) ? Number(el.duration) : 0;
    const score =
      (!el.paused ? 1000 : 0) +
      (el.currentTime > 0 ? 140 : 0) +
      (duration > 0 ? 80 : 0) +
      ((el.readyState || 0) * 20) +
      Math.min(80, Math.max(0, rect.width * rect.height / 9000));
    return { el, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
  const el = scored[0] && scored[0].el;
  if (!el) return null;
  const md = navigator.mediaSession && navigator.mediaSession.metadata;
  const art = md && md.artwork && md.artwork.length ? md.artwork[md.artwork.length - 1].src : '';
  const tracks = Array.from(el.textTracks || []);
  const host = location.hostname.replace(/^www\\./, '');
  return {
    type: 'mediaState',
    available: true,
    active: !el.paused,
    paused: !!el.paused,
    current: Number(el.currentTime) || 0,
    duration: Number.isFinite(el.duration) ? (Number(el.duration) || 0) : 0,
    title: (md && md.title) || document.title || host || 'Media',
    artist: (md && md.artist) || '',
    artwork: art || '',
    host,
    captionsOn: tracks.some(t => t.mode === 'showing')
  };
})()`;

function mediaCommandJS(cmd) {
  return `(async () => {
    const pickMedia = () => Array.from(document.querySelectorAll('video,audio'))
      .map(el => ({
        el,
        score: (!el.paused ? 1000 : 0) + (el.currentTime > 0 ? 120 : 0) +
               (Number.isFinite(el.duration) && el.duration > 0 ? 80 : 0) + ((el.readyState || 0) * 20)
      }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.el || null;
    const clickAny = selectors => {
      for (const s of selectors) {
        const node = document.querySelector(s);
        if (node) { node.click(); return true; }
      }
      return false;
    };
    const cmd = ${JSON.stringify(cmd)};
    if (cmd === 'next') return clickAny(['.ytp-next-button', '[aria-label*="Next"]', '[aria-label*="Suivant"]', '[title*="Next"]', '[title*="Suivant"]']);
    if (cmd === 'prev') return clickAny(['.ytp-prev-button', '[aria-label*="Previous"]', '[aria-label*="Précédent"]', '[aria-label*="Precedent"]', '[title*="Previous"]', '[title*="Précédent"]']);
    const el = pickMedia();
    if (!el) return false;
    if (cmd === 'playPause') {
      if (el.paused) { try { await el.play(); } catch (e) {} }
      else el.pause();
      return true;
    }
    if (cmd === 'seekBack') { el.currentTime = Math.max(0, (Number(el.currentTime) || 0) - 10); return true; }
    if (cmd === 'seekForward') {
      const dur = Number.isFinite(el.duration) ? el.duration : Infinity;
      el.currentTime = Math.min(dur, (Number(el.currentTime) || 0) + 10);
      return true;
    }
    if (cmd === 'captions') {
      const tracks = Array.from(el.textTracks || []);
      if (tracks.length) {
        const on = tracks.some(t => t.mode === 'showing');
        tracks.forEach(t => { t.mode = on ? 'disabled' : 'showing'; });
        return true;
      }
      return clickAny(['.ytp-subtitles-button', '[aria-label*="captions"]', '[aria-label*="sous-titres"]', '[title*="captions"]', '[title*="sous-titres"]']);
    }
    if (cmd === 'captionSettings') return clickAny(['.ytp-settings-button', '[aria-label*="Settings"]', '[aria-label*="Paramètres"]']);
    return false;
  })()`;
}

async function getTabMediaState(tab) {
  const wc = tab && tab.view && tab.view.webContents;
  if (!wc || wc.isDestroyed()) return null;
  try {
    const st = await wc.executeJavaScript(MEDIA_STATE_JS, true);
    if (st && st.available) {
      st.tabId = tab.id;
      st.url = wc.getURL();
      return st;
    }
  } catch {}
  try {
    if (wc.isCurrentlyAudible && wc.isCurrentlyAudible()) {
      return {
        type: 'mediaState',
        available: true,
        active: true,
        paused: false,
        current: 0,
        duration: 0,
        title: wc.getTitle() || 'Media',
        artist: '',
        artwork: '',
        host: new URL(wc.getURL()).hostname.replace(/^www\\./, ''),
        captionsOn: false,
        tabId: tab.id,
        url: wc.getURL(),
      };
    }
  } catch {}
  return null;
}

async function sendMediaState() {
  if (!chromeView) return;
  const ordered = [];
  const act = activeTab();
  if (act) ordered.push(act);
  for (const t of tabs) if (!act || t.id !== act.id) ordered.push(t);
  for (const t of ordered) {
    const st = await getTabMediaState(t);
    if (st) { chromeView.webContents.send('zaalis:message', st); return; }
  }
  chromeView.webContents.send('zaalis:message', { type: 'mediaState', available: false });
}

async function runMediaCommand(cmd, tabId) {
  const id = parseInt(tabId, 10);
  let tab = tabs.find(t => t.id === id) || activeTab();
  if (!tab) return;
  try { await tab.view.webContents.executeJavaScript(mediaCommandJS(cmd), true); } catch {}
  setTimeout(sendMediaState, 120);
}

// ----- Bus de messages ------------------------------------------------------

function handleAction(a, args, event) {
  const arg = i => (i < args.length ? args[i] : '');
  switch (a) {
    case 'ready':          pushState(); pushAiStatusToTabs(); pushShortcuts(); pushAiMode(); pushDownloads(); break;
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
    case 'newIncognito':   openIncognitoTab(); break;
    case 'openInNewTab':   createTab(arg(0), true); break;
    case 'closeTab':       closeTab(parseInt(arg(0), 10)); break;
    case 'selectTab':      selectTab(parseInt(arg(0), 10)); break;
    case 'reorderTabs':    reorderTabs(arg(0)); break;
    case 'tabMenu':        showTabMenu(parseInt(arg(0), 10)); break;
    case 'pinTab':         togglePinTab(parseInt(arg(0), 10)); break;
    case 'installApp':     installAsApp(parseInt(arg(0), 10)); break;
    case 'translatePage':  translatePage('français'); break;
    case 'toggleDevTools': { const t = activeTab(); if (t) { const w = t.view.webContents; w.isDevToolsOpened() ? w.closeDevTools() : w.openDevTools({ mode: 'detach' }); } break; }
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
    // ----- Mode vocal (page d'accueil) -----
    case 'voiceStart':     if (event) voiceStart(event.sender); break;
    case 'voiceStop':      voiceStop(); break;
    case 'voiceAudio':     if (event) voiceTurn(event.sender, arg(0)); break;
    case 'setAiProvider': {
      const p = arg(0);
      if (AI_PROVIDERS[p]) {
        settings.aiProvider = p;
        if (!validAiChoice(p, settings.aiSubmodel)) settings.aiSubmodel = AI_PROVIDERS[p].submodels[0] || settings.aiSubmodel;
        saveSettings(); pushPanelState(); pushAiPanelState();
      }
      break;
    }
    case 'setAiSubmodel':  if (validAiChoice(settings.aiProvider, arg(0))) { settings.aiSubmodel = arg(0); saveSettings(); pushPanelState(); pushAiPanelState(); } break;
    case 'setVoiceProvider': {
      const p = arg(0);
      if (AI_PROVIDERS[p]) {
        settings.voiceProvider = p;
        if (!validAiChoice(p, settings.voiceSubmodel)) settings.voiceSubmodel = AI_PROVIDERS[p].submodels[0] || settings.voiceSubmodel;
        saveSettings(); pushPanelState();
      }
      break;
    }
    case 'setVoiceSubmodel':
      if (validAiChoice(settings.voiceProvider, arg(0))) { settings.voiceSubmodel = arg(0); saveSettings(); pushPanelState(); }
      break;
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
    case 'reload':         { const t = activeTab(); if (t) reloadFresh(t.view.webContents); break; }
    case 'getSiteInfo':    sendSiteInfo(event ? event.sender : null); break;
    case 'clearSiteData':  clearActiveSiteData(event ? event.sender : null); break;
    case 'resetSitePermissions': resetActiveSitePermissions(event ? event.sender : null); break;
    case 'home':           navigateActive(HOME_URL); break;
    case 'toggleMaximize': if (mainWin) { mainWin.isMaximized() ? mainWin.unmaximize() : mainWin.maximize(); } break;
    case 'togglePanel':    togglePanel(); break;
    case 'closePanel':     closePanel(); break;
    case 'panelReady':
      panelLoaded = true;
      pushPanelState(); pushDownloads();
      if (pendingPanelHistory) { sendPanelHistory(); pendingPanelHistory = false; }
      if (pendingPanelDownloads) { pendingPanelDownloads = false; showPanelDownloads(); }
      break;
    case 'getHistory':     sendPanelHistory(); break;
    case 'getDownloads':   pushDownloads(); break;
    case 'cancelDownload': cancelDownload(arg(0)); break;
    case 'showDownload':   showDownload(arg(0)); break;
    case 'openDownload':   openDownload(arg(0)); break;
    case 'removeDownload': removeDownload(arg(0)); break;
    case 'clearDownloads': clearDownloads(); break;
    case 'openDownloadsPanel': openPanel(); showPanelDownloads(); break;
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
    case 'setRestoreTabs':
      settings.restoreTabs = arg(0) === '1';
      saveSettings();
      if (settings.restoreTabs) saveOpenTabsNow();
      else clearSessionTabs();
      pushPanelState();
      break;
    case 'setSafeSearch':       settings.safeSearch = arg(0) === '1'; saveSettings(); pushPanelState(); break;
    case 'setHttpsOnly':        settings.httpsOnly = arg(0) === '1'; saveSettings(); pushPanelState(); break;
    case 'setSafeBrowsing':     settings.safeBrowsing = arg(0) === '1'; saveSettings(); pushPanelState(); break;
    case 'resetPermissions':    sitePermissions = {}; saveSitePermissions(); break;
    case 'setSearchEngine':     setSearchEngine(arg(0)); break;
    case 'setZoomPct':          setZoomPct(parseInt(arg(0), 10)); break;
    case 'resetSettings':       resetSettings(); break;
    case 'getMediaState':
      sendMediaState();
      break;
    case 'mediaCommand':
      runMediaCommand(arg(0), arg(1));
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

const HOME_ACTIONS = new Set([
  'ready', 'addShortcut', 'navigate', 'removeShortcut', 'setAiMode',
  'suggest', 'togglePanel', 'aiSearch',
  // Recherche vocale : ces messages ne viennent que de zaalis://home/index.html.
  'voiceStart', 'voiceStop', 'voiceAudio',
]);
const AISEARCH_ACTIONS = new Set(['runAiSearch']);

function trustedIpcAction(event, action) {
  const sender = event && event.sender;
  if (!sender || !action) return false;
  // Les trois vues d'interface ont une identité WebContents dédiée.
  if ((chromeView && sender === chromeView.webContents) ||
      (panelView && sender === panelView.webContents) ||
      (aiPanelView && sender === aiPanelView.webContents)) return true;

  const tab = tabs.find(t => t.view && sender === t.view.webContents);
  if (!tab) return false;
  if (event.senderFrame && sender.mainFrame && event.senderFrame !== sender.mainFrame) return false;
  let page = '';
  try { page = new URL(sender.getURL()).pathname.replace(/^\/+/, ''); } catch { return false; }
  if (!isAllowedInternalUrl(sender.getURL())) return false;
  if (page === '' || page === 'index.html') return HOME_ACTIONS.has(action);
  if (page === 'aisearch.html') return AISEARCH_ACTIONS.has(action);
  return false;
}

ipcMain.on('zaalis:postMessage', (event, str) => {
  if (typeof str !== 'string') return;
  const parts = str.split(SEP);
  if (!trustedIpcAction(event, parts[0])) return;
  // Un tour vocal peut contenir jusqu'à 30 secondes de PCM 16 kHz encodé en
  // base64 (~1,3 Mo). La limite générale reste stricte pour toute autre action.
  const maxLength = parts[0] === 'voiceAudio' ? 5 * 1024 * 1024 : 65536;
  if (str.length > maxLength) return;
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
  // Sans en-tête de cache, Chromium peut mettre en cache disque une reponse
  // zaalis://home/*.html indefiniment (le schema est enregistre 'standard').
  // Ce cache SURVIT aux redemarrages de l'app (meme dossier userData) : une
  // fenetre (ex. le panneau IA) chargee une seule fois par run peut ainsi
  // continuer a executer un JS perime meme apres correction du fichier source
  // sur disque. On force systematiquement une lecture fraiche.
  return new Response(buf, { headers: { 'content-type': mime, 'cache-control': 'no-store' } });
}

// Enregistre le handler sur la session par défaut ET sur la session persistée
// des onglets. Sans ça, les onglets (partition:'persist:zaalis-browser') ne
// voient pas le protocole et zaalis://home/* échoue.
function registerProtocol() {
  session.defaultSession.protocol.handle('zaalis', zaalisProtocolHandler);
  // Session de l'invité : protocole zaalis:// + téléchargements + permissions.
  // Les profils et la navigation privée obtiennent leur session à la volée
  // (setupSession) dès qu'un onglet y est créé.
  setupSession('persist:zaalis-browser');
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
    res.setHeader('content-type', 'application/json; charset=utf-8');

    let action = null, value = '';
    if (path0 === '/ping')                        { res.end(JSON.stringify({ ok: true, name: 'zaalis browser' })); return; }
    if (path0 === '/search' || path0 === '/open') { action = path0.slice(1); value = q.q || q.url || ''; }
    else if (path0 === '/newtab')                 { action = 'newtab'; value = q.url || q.q || ''; }
    else if (path0 === '/')                       { res.end('zaalis browser api'); return; }

    if (!action) { res.statusCode = 404; res.end('no'); return; }

    // Les actions locales partagent le même secret que le pont IDE. Un site
    // web ne peut pas forger cet en-tête et les requêtes anonymes échouent.
    if (req.method !== 'GET') { res.statusCode = 405; res.end(JSON.stringify({ ok: false })); return; }
    const expected = Buffer.from(ideSecret());
    const supplied = Buffer.from(String(req.headers['x-zaalis-browser'] || ''));
    const authenticated = expected.length >= 16 && supplied.length === expected.length &&
      crypto.timingSafeEqual(supplied, expected);
    if (!authenticated) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); return; }

    value = String(value || '').slice(0, 4096);

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
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  chromeView.setBackgroundColor('#00000000');
  lockInternalView(chromeView.webContents, CHROME_URL);
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

  const saved = settings.restoreTabs ? loadSessionTabs() : null;
  if (saved && saved.urls.length) {
    saved.urls.forEach((u, i) => createTab(u, i === 0));
    if (tabs[saved.active]) selectTab(tabs[saved.active].id);
  } else {
    createTab('', true);
  }
  layoutAll();
}

// ----- App lifecycle --------------------------------------------------------

app.setName('zaalis browser');

// Autorise la lecture continue demandée par l'utilisateur (notamment le
// passage automatique au titre suivant des playlists YouTube). Sans ce réglage
// Chromium peut considérer la vidéo suivante comme un nouvel autoplay.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Empêche une deuxième instance (l'API HTTP fait déjà foreground).
// Self-test de l'agent : données isolées dans un appData temporaire pour ne
// jamais toucher le vrai profil (et éviter le verrou single-instance de l'app
// installée). Voir runAgentSelfTest().
const AGENT_SELFTEST = process.env.ZAALIS_AGENT_SELFTEST || '';
if (AGENT_SELFTEST) {
  const base = path.join(os.tmpdir(), 'zaalis-agent-selftest');
  app.setPath('appData', base);
  app.setPath('userData', path.join(base, 'zaalis browser'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  if (mainWin) { mainWin.show(); mainWin.focus(); }
});

app.on('before-quit', () => {
  if (saveTabsTimer) { clearTimeout(saveTabsTimer); saveTabsTimer = null; }
  saveOpenTabsNow();
});

app.whenReady().then(() => {
  ensureDataFolder();
  loadSettings();
  loadProfiles();
  loadSitePermissions();
  loadProfileData();   // favoris/raccourcis/historique/lanceur du profil courant
  loadAiChats();
  startIdeStatusWatcher();
  registerProtocol();  // enregistre aussi téléchargements + permissions (invité)
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
    { label: 'Onglets', submenu: [
      { label: 'Nouvel onglet',            accelerator: 'CmdOrCtrl+T',       click: () => createTab('', true) },
      { label: 'Nouvel onglet privé',      accelerator: 'CmdOrCtrl+Shift+N', click: () => openIncognitoTab() },
      { label: 'Rouvrir l\'onglet fermé',  accelerator: 'CmdOrCtrl+Shift+T', click: () => reopenClosedTab() },
      { label: 'Fermer l\'onglet',         accelerator: 'CmdOrCtrl+W',       click: () => { const t = activeTab(); if (t) closeTab(t.id); } },
      { type: 'separator' },
      { label: 'Onglet suivant',           accelerator: 'Ctrl+Tab',          click: () => cycleTab(1) },
      { label: 'Onglet précédent',         accelerator: 'Ctrl+Shift+Tab',    click: () => cycleTab(-1) },
      { label: 'Aller à l\'onglet', submenu: [1,2,3,4,5,6,7,8].map(n => (
          { label: 'Onglet ' + n, accelerator: 'CmdOrCtrl+' + n, click: () => gotoTab(n) }
        )).concat([{ label: 'Dernier onglet', accelerator: 'CmdOrCtrl+9', click: () => gotoTab(9) }]) },
      { label: 'Rechercher un onglet',     accelerator: 'CmdOrCtrl+Shift+A', click: () => { if (chromeView) chromeView.webContents.send('zaalis:message', { type: 'openTabSearch' }); } },
    ]},
    { label: 'Navigation', submenu: [
      { label: 'Reculer',                  accelerator: 'CmdOrCtrl+Left',    click: () => { const t = activeTab(); if (t && t.view.webContents.navigationHistory.canGoBack())    t.view.webContents.navigationHistory.goBack(); } },
      { label: 'Avancer',                  accelerator: 'CmdOrCtrl+Right',   click: () => { const t = activeTab(); if (t && t.view.webContents.navigationHistory.canGoForward()) t.view.webContents.navigationHistory.goForward(); } },
      { label: 'Actualiser',               accelerator: 'CmdOrCtrl+R',       click: () => { const t = activeTab(); if (t) reloadFresh(t.view.webContents); } },
      { label: 'Actualiser sans le cache', accelerator: 'CmdOrCtrl+Shift+R', click: () => { const t = activeTab(); if (t) reloadFresh(t.view.webContents); } },
      { label: 'Accueil',                  accelerator: 'CmdOrCtrl+Shift+H', click: () => navigateActive(HOME_URL) },
      { label: 'Focus barre d\'adresse',   accelerator: 'CmdOrCtrl+L',       click: () => { if (chromeView) chromeView.webContents.send('zaalis:message', { type: 'focusOmni' }); } },
      { type: 'separator' },
      { label: 'Ajouter aux favoris',      accelerator: 'CmdOrCtrl+D',       click: () => toggleBookmark() },
      { label: 'Historique',               accelerator: 'CmdOrCtrl+Y',       click: () => openHistoryPanel() },
      { label: 'Téléchargements',          accelerator: 'CmdOrCtrl+Shift+J', click: () => { openPanel(); showPanelDownloads(); } },
      { type: 'separator' },
      { label: 'Outils de développement',  accelerator: 'Alt+Cmd+I',         click: () => { const t = activeTab(); if (t) { const w = t.view.webContents; w.isDevToolsOpened() ? w.closeDevTools() : w.openDevTools({ mode: 'detach' }); } } },
    ]},
    { label: 'Affichage', submenu: [
      { label: 'Zoom avant',    accelerator: 'CmdOrCtrl+Plus',  click: () => setZoomPct((settings.zoomPct || 100) + 10) },
      { label: 'Zoom avant',    accelerator: 'CmdOrCtrl+=',     acceleratorWorksWhenHidden: true, visible: false, click: () => setZoomPct((settings.zoomPct || 100) + 10) },
      { label: 'Zoom arrière',  accelerator: 'CmdOrCtrl+-',     click: () => setZoomPct((settings.zoomPct || 100) - 10) },
      { label: 'Taille réelle', accelerator: 'CmdOrCtrl+0',     click: () => setZoomPct(100) },
      { type: 'separator' },
      { role: 'togglefullscreen', label: 'Plein écran' },
    ]},
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  if (AGENT_SELFTEST) {
    runAgentSelfTest(AGENT_SELFTEST).catch((e) => {
      console.error('[selftest] échec inattendu :', e);
      app.exit(1);
    });
  }
});

// ----- Self-test de l'agent (développement) -----------------------------------
// ZAALIS_AGENT_SELFTEST=tools   : vérifie read_page/click/fill/curseur sur une
//                                 page locale, imprime un rapport puis quitte.
// ZAALIS_AGENT_SELFTEST=mistral : idem + boucle agent complète via zaalis labs
//                                 ide (provider Mistral) sur la même page.
async function runAgentSelfTest(mode) {
  const results = [];
  const check = (name, pass, extra) => {
    results.push({ name, pass: !!pass });
    console.log('  ' + (pass ? 'PASS' : 'FAIL') + '  ' + name +
                (!pass && extra ? '  — ' + String(extra).replace(/\n/g, ' ').slice(0, 200) : ''));
  };
  setTimeout(() => { console.log('[selftest] délai global dépassé'); app.exit(1); }, 240000);

  const TEST_PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!doctype html><html><head><title>Page de test agent</title></head><body>' +
    '<h1>Test agent zaalis</h1><p>Paragraphe de démonstration.</p>' +
    '<button id="btn" onclick="window.__n=(window.__n||0)+1;document.getElementById(\'out\').textContent=\'cliqué:\'+window.__n;console.log(\'bouton cliqué\')">Ajouter au panier</button>' +
    '<div id="out">jamais</div>' +
    '<form onsubmit="event.preventDefault();document.getElementById(\'res\').textContent=\'soumis:\'+document.getElementById(\'q\').value">' +
    '<input id="q" placeholder="Rechercher" value="ancien texte"><div id="res">rien</div></form>' +
    '<a href="#bas">Mon compte</a>' +
    '</body></html>');

  console.log('=== Self-test agent zaalis (' + mode + ') ===');
  const wrappedCall = parseToolCall('```zaalis-tool\n{"tool":"fill","args":{"ref":"ref_12","value":"test"}}\n```');
  const flatCall = parseToolCall('```json\n{"tool":"fill","ref":"ref_12","value":"test"}\n```');
  check('parseur : arguments enveloppés conservés', wrappedCall && wrappedCall.args.ref === 'ref_12' && wrappedCall.args.value === 'test');
  check('parseur : arguments racine conservés', flatCall && flatCall.args.ref === 'ref_12' && flatCall.args.value === 'test');
  check('recherche vocale : messages IPC autorisés', ['voiceStart', 'voiceStop', 'voiceAudio'].every(a => HOME_ACTIONS.has(a)));
  createTab('', true);
  const t = activeTab();
  const wc = t.view.webContents;
  await waitLoad(wc, 8000);
  await wc.loadURL(TEST_PAGE);
  await waitLoad(wc, 8000);
  await sleepMs(400);

  // 1) read_page : arbre d'accessibilité avec refs
  const tree = await runAgentTool(t, 'read_page', {});
  check('read_page : bouton avec ref', /button "Ajouter au panier" \[ref_\d+\]/.test(tree), tree);
  check('read_page : champ texte avec valeur', /textbox "Rechercher" \[ref_\d+\] \(valeur: "ancien texte"\)/.test(tree), tree);
  check('read_page : titre h1', tree.includes('h1 "Test agent zaalis"'), tree);
  check('read_page : lien avec ref', /link "Mon compte" \[ref_\d+\]/.test(tree), tree);

  const btnRef   = (tree.match(/button "Ajouter au panier" \[(ref_\d+)\]/) || [])[1];
  const inputRef = (tree.match(/textbox "Rechercher" \[(ref_\d+)\]/) || [])[1];

  // 2) click par ref → vrai clic natif, le handler de la page doit tourner
  const c1 = await runAgentTool(t, 'click', { ref: btnRef });
  await sleepMs(150);
  let out = await wc.executeJavaScript('document.getElementById("out").textContent', true);
  check('click par ref : handler déclenché', out === 'cliqué:1', c1 + ' / out=' + out);

  // 3) click par texte (repli sans ref)
  await runAgentTool(t, 'click', { text: 'ajouter au panier' });
  await sleepMs(150);
  out = await wc.executeJavaScript('document.getElementById("out").textContent', true);
  check('click par texte', out === 'cliqué:2', 'out=' + out);

  // 4) curseur agent présent dans la page (overlay monde isolé)
  const cursor = await agentExec(wc, '!!(window.__zCur && window.__zCur.root.isConnected)');
  check('curseur agent visible (overlay)', cursor === true);
  await agentHoldCursor(wc, 'Analyse en cours');
  const heldAt = await agentExec(wc, '({opacity:window.__zCur.cur.style.opacity,transform:window.__zCur.cur.style.transform})');
  await sleepMs(2800);
  const stillHeld = await agentExec(wc, 'window.__zCur.cur.style.opacity');
  check('curseur maintenu entre deux outils', heldAt.opacity === '1' && stillHeld === '1');

  // 5) fill + enter : REMPLACE l'ancienne valeur puis soumet le formulaire
  const f1 = await runAgentTool(t, 'fill', { ref: inputRef, value: 'zaalis test', enter: true });
  const movedToField = await agentExec(wc, 'window.__zCur.cur.style.transform');
  check('curseur glissé vers le champ', movedToField !== heldAt.transform, movedToField);
  const val = await wc.executeJavaScript('document.getElementById("q").value', true);
  const res = await wc.executeJavaScript('document.getElementById("res").textContent', true);
  check('fill : valeur remplacée (pas concaténée)', val === 'zaalis test', f1 + ' / value=' + val);
  check('fill + enter : formulaire soumis', res === 'soumis:zaalis test', 'res=' + res);

  // 6) console de la page capturée
  const logs = await runAgentTool(t, 'read_console', {});
  check('read_console : log du clic', String(logs).includes('bouton cliqué'), logs);

  // 7) rechargement → les refs de l'ancien document doivent être refusés proprement
  wc.reload();
  await waitLoad(wc, 8000);
  await sleepMs(300);
  const stale = await runAgentTool(t, 'click', { ref: btnRef });
  check('refs invalidés après rechargement', String(stale).includes('référence inconnue'), stale);

  if (mode === 'mistral') {
    settings.aiProvider = 'mistral';
    settings.aiSubmodel = 'mistral-large-latest';
    console.log('--- Boucle agent complète (mistral / ' + settings.aiSubmodel + ') ---');
    await wc.loadURL(TEST_PAGE);
    await waitLoad(wc, 8000);
    await sleepMs(300);
    newAiChat('selftest');
    await aiChatSend('Clique sur le bouton « Ajouter au panier » puis dis-moi le contenu exact de l\'élément #out.');
    const chat = aiChatById(aiCurrentChatId);
    const msgs = chat ? chat.messages : [];
    const toolSteps = msgs.filter((m) => m.role === 'tool').map((m) => m.label);
    const reply = String((msgs[msgs.length - 1] || {}).content || '');
    console.log('  étapes outils : ' + (toolSteps.join(' | ') || '(aucune)'));
    console.log('  réponse finale : ' + reply.replace(/\n/g, ' ').slice(0, 300));
    const outNow = await wc.executeJavaScript('document.getElementById("out").textContent', true);
    check('mistral : le bouton a réellement été cliqué', /^cliqué:[1-9]/.test(outNow), 'out=' + outNow);
    check('mistral : réponse finale propre (sans bloc outil)', reply.length > 0 && !reply.includes('zaalis-tool'), reply);
  }

  const fails = results.filter((r) => !r.pass).length;
  console.log('=== ' + (results.length - fails) + '/' + results.length + ' OK ===');
  app.exit(fails ? 1 : 0);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWin) createWindow();
});
