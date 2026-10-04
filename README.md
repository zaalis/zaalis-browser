# zaalis Browser for Windows

zaalis Browser is the Windows edition of the zaalis web workspace. It is an
Electron application powered by Chromium, with a native Windows installer and
persistent local data in `%APPDATA%\zaalis browser`.

It is built on [Electron for Content Security](https://github.com/castlabs/electron-releases)
(castlabs ECS), a drop-in Electron build that adds the Google Widevine CDM, so
DRM-protected streaming services (Prime Video, Netflix, Disney+, Canal+,
Spotify…) can play like in Google Chrome.

## Included features

- Tabs, bookmarks, history, profiles and private browsing
- Split view, downloads (save as, resume), media controls and pinned web applications
- Chrome-like site permissions: camera and microphone asked separately, "allow
  this time" or remembered per site, protected content (DRM) allowed by default,
  screen sharing picker, Bluetooth/HID/USB/serial device choosers
- Chrome-like pop-up blocker (pop-ups need a click), `window.opener` kept for
  "Sign in with Google/Apple", PayPal and 3-D Secure pop-ups
- Links to apps (`mailto:`, `tel:`, Zoom, Teams…) opened after confirmation
- Video fullscreen (YouTube, Prime Video…) and F11 immersive mode
- Find in page, print, save page as, view source, full context menu
- HTTP authentication dialog, network error pages and crashed-tab recovery
- Search, voice search and contextual zaalis labs IDE assistance
- Windows 10 and Windows 11 title-bar integration and Chrome keyboard shortcuts
  (Ctrl+T/W/Shift+T, Ctrl+Tab, Alt+←/→, F5, Ctrl+F, F3, Ctrl+H, Ctrl+J, Ctrl+P,
  Ctrl+S, Ctrl+U, F11, F12, mouse back/forward buttons…)

## Development

```powershell
npm install
npm start
npm test
npm run selftest
```

`npm install` downloads the castlabs Electron binary (`postinstall`). On first
launch, the Widevine CDM is installed automatically in the user data folder and
updated in the background afterwards.

## Build installers

```powershell
.\scripts\build-win.ps1
```

The generated x64 Windows NSIS installer is `dist/zaalisBrowser-<version>-setup.exe`.
It lets the user select an installation directory and creates Start menu and
desktop shortcuts.

### Widevine production signing (Prime Video, Netflix…)

castlabs builds are only signed for Widevine *development*. Production
streaming services require a **VMP production signature**, provided free of
charge by the castlabs EVS service. One-time setup (requires your own e-mail
address for account confirmation):

```powershell
py -3 -m pip install --upgrade castlabs-evs
py -3 -m castlabs_evs.account signup
```

Every build then signs the packaged application automatically
(`scripts/after-pack.js`, after the icon is written into the executable). Set
`ZAALIS_REQUIRE_VMP=1` to make a missing signature fail the build. Refresh the
EVS login once a month with `py -3 -m castlabs_evs.account reauth`.

## License and trademark

The source code is released under the [GNU AGPLv3](LICENSE). The **zaalis**
name, logos and visual identity remain reserved to zaalis.
