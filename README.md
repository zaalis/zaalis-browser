# zaalis Browser for Windows

zaalis Browser is the Windows edition of the zaalis web workspace. It is an
Electron application powered by Chromium WebView, with a native Windows
installer and persistent local data in `%APPDATA%\\zaalis Browser`.

## Included features

- Tabs, bookmarks, history, profiles and private browsing
- Split view, downloads, media controls and pinned web applications
- Per-site privacy and permission controls
- Search, voice search and contextual zaalis labs IDE assistance
- Windows 10 and Windows 11 title-bar integration and shortcuts

## Development

```powershell
npm install
npm start
npm test
npm run selftest
```

## Build installers

```powershell
.\scripts\build-win.ps1
```

The generated x64 Windows NSIS installer is `dist/zaalisBrowser-<version>-setup.exe`.
It lets the user select an installation directory and creates Start menu and
desktop shortcuts.

## License and trademark

The source code is released under the [GNU AGPLv3](LICENSE). The **zaalis**
name, logos and visual identity remain reserved to zaalis.
