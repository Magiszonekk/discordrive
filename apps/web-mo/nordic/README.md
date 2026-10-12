# nordic (trimmed copy)

Copy of `~/Desktop/nordic/dist` (version in VERSION.json): only `tokens.css`, `theme.js` and `fonts/`
(the app has its own component CSS in index.html, built on the `--nd-*` tokens). Do not edit here:
change the package, `node scripts/build.mjs`, then copy these files again.
build.ts copies this folder to dist/nordic. `theme.js` is loaded as an external script (the CSP has no
'unsafe-inline' for scripts) and keeps the light/dark choice in the shared `cik_theme` cookie.
