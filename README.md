# zaalis Browser for macOS

The browser that extends **zaalis labs ide** to the Web.

zaalis Browser turns browsing into a workspace. It combines a fast macOS
experience, isolated personal spaces, precise privacy controls, and contextual
assistance connected to zaalis labs ide. The result is less friction between
research, reading, organization, and action.

## Built for modern work

The interface stays familiar while bringing the tools that matter every day:
tabs stay in sync, recently published pages are refreshed cleanly, and zaalis
labs ide assistance is available directly in the browser whenever it is
available locally.

## Features

- Persistent tabs, bookmarks, history, and shortcuts
- Split view for comparing two pages side by side
- Independent profiles with separate cookies, permissions, bookmarks, and history
- Private browsing with a temporary session
- Cache-bypassing refresh and revalidation of background tabs
- Per-site information panel for connections, cookies, data, and permissions
- HTTPS, permission controls, and protection against unsafe websites
- Search, voice search, and navigation suggestions
- Contextual assistance, AI search, and guided page interaction through zaalis
  labs ide
- Downloads, media controls, and pinned web applications
- Modern macOS interface for Apple Silicon and Intel Macs

## Installation

Download the file for your Mac from the releases page:

- `zaalisBrowser-*-arm64.dmg` — Apple Silicon Macs (M1, M2, M3, M4…)
- `zaalisBrowser-*-x64.dmg` — Intel Macs

Open the DMG, then drag **zaalis browser** into the **Applications** folder.

> Development builds may not be signed by Apple. macOS may request confirmation
> the first time the application is opened.

## Development

```bash
npm install
npm start
```

To build the macOS disk images:

```bash
npm run pack:all
```

## License and trademark

The source code is released under the [GNU AGPLv3](LICENSE). Any modified or
redistributed version must retain this license and make its source code
available under the terms of the AGPLv3.

The **zaalis** name, logos, and visual identity are not licensed under the
AGPLv3. They may not be used to present a derivative product as official or
endorsed by zaalis.
