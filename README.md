# FlashQuant v2

Static site, no build step. Deploy the folder as-is on Vercel (Framework preset: Other, no build command, output directory = root).

Files
- index.html, styles.css, app.js  page and wiring
- core.js      schema, settings fingerprint, problems, stats, CSV, import sanitising (pure, tested)
- db.js        IndexedDB storage, one-time migration from the old localStorage data, validated backup import
- engine.js    game loop with a real deadline timer, quit handling
- tricks.js    technique tips matched to weak spots
- config.js    cloud URL and public key (leave SUPABASE_URL empty for local-only mode)
- sync.js      cloud sync: merge by round id, never duplicates; account.js is its UI
- charts.js    SVG charts (no libraries)
- analysis.js  post-round analysis page

Tests: `npm test` runs core only. Run all with: node core.test.js && node db.test.js && node engine.test.js

Migration: on first load at the same domain, old zm_hist / zm_probs data is imported once. The old keys are left in place as a safety copy.

Cloud accounts: see SETUP-SUPABASE.md. Everything still works with no account; sync is optional.
