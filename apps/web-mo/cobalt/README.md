# Cobalt (the look of discordrive)

The same theme as the current discordrive app (old-drive.example.com, `discordrive/apps/frontend`,
`design.md` = Cobalt / Hallmark), replaces nordic.

- `tokens.css`: discordrive's `tokens.css` (`@theme` block as plain custom properties, light + dark) and
  `index.css` (base, scrollbars, focus ring, `.chip`, `.reveal`), plus `@font-face` for the local fonts.
- `app.css`: the app-shell and pages of web-mo, written with the same values discordrive gets from its
  Tailwind classes (sidebar `w-64`, `rounded-md` 6 px, `rounded-card` 10 px, `h-11` inputs, …).
- `theme.js`: light / dark / system like discordrive's `ColorModeToggle` (localStorage `ddn.color-mode`).
- `fonts/`: Space Grotesk, Inter, JetBrains Mono (variable, latin + latin-ext, @fontsource-variable 5.3.0,
  SIL OFL 1.1, licences next to them).

`build.ts` copies this folder to `dist/cobalt`.
