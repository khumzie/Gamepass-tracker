# GamePass Tracker PWA

An iPhone-first Xbox Game Pass tracker and personal backlog PWA.

## Features
- **Always Populated**: Comes bundled with the complete Game Pass library (`games.json`, 800+ titles) so the app loads instantly on first launch and never shows empty.
- **Auto-Sync & Updates**:
  - **In-App Refresh**: Tap **Refresh** to check for newly added Game Pass titles from both host updates and Microsoft endpoints.
  - **Automated Daily Sync**: Built-in GitHub Action (`.github/workflows/update-catalogue.yml`) queries Microsoft's API daily at 04:00 UTC and auto-commits new additions to `games.json`.
  - **Manual Update Command**: Run `npm run update` locally anytime to fetch the latest titles directly from Microsoft.
- **Filters & Search**:
  - Filter by platform (**Xbox Console**, **PC**, **EA Play**).
  - Search by game title, studio / developer, or keywords.
  - Filter by backlog status (**Want to play**, **Played**, **Skip**, or **Unmarked**).
  - Sort by **Newest added**, **A–Z**, **Z–A**, or **My status**.
- **Game Details Sheet**: Tap any game card to view description, developer, platform tags, release date, and direct Xbox Store link.
- **Offline & Storage**:
  - Backlog statuses are stored securely in local IndexedDB.
  - PWA service worker caches shell and assets for offline use.
  - **Export / Import**: Easily backup or transfer your backlog between devices from the Settings drawer.

## Install on iPhone & Mobile
1. Host this folder on any HTTPS static host (GitHub Pages, Cloudflare Pages, Netlify, Vercel, etc.).
2. Open the HTTPS URL in Safari on iPhone.
3. Tap **Share → Add to Home Screen**.
4. Launch the **GamePass Tracker** icon from your home screen.

## Local Development & Updating Catalogue
To preview locally:
```bash
# Serve the PWA locally
npx serve .
```

To update the Game Pass catalogue manually with the latest titles:
```bash
npm run update
```

## Data
Catalogue data is fetched from Microsoft's public Xbox endpoints for the UK market (`en-gb`, `GB`). This tool is unofficial and not affiliated with Microsoft or Xbox.
