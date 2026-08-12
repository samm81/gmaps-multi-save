# Archived bookmarklet workflow

This directory contains the former browser-console and bookmarklet implementation. It is retained for historical reference and is not part of the active `make` build.

The workflow was retired because Google Maps changed its Content Security Policy, which broke the in-page navigation approach used by the bookmarklet. Use the root Playwright runner instead:

```bash
npm run gmaps:login
npm run gmaps:save-list -- places.csv
```

## Former Eater workflow

1. Create a browser bookmark.
2. Use the generated `bookmarklet-eater.js` as the bookmark URL.
3. Open an Eater map page and run the bookmarklet.
4. Enter the Google Maps list name when prompted.
5. Paste the generated script into the Google Maps browser console.

The source files are `from-eater.js`, `gmaps-add.js`, and `make-gmaps-paste-snippet.js`. The CSV paste-snippet source is `csv-to-gmaps-paste-snippet.partial.mjs`. The old demonstration videos are in `assets/`.
