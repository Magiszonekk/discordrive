# Design — DiscorDrive

A locked design system for this app. Every page redesign reads this file before
emitting code. Do not regenerate per page — extend or amend this file when the
system needs to grow.

## Genre
modern-minimal

## Theme
Cobalt (catalog) — cool engineered near-white paper, one electric-cobalt signal
accent, hairline structure, tight radii, code/data as first-class content.
Picked for: technical audience (E2EE, Argon2, chunk health checks), utilitarian
tone, "manage files fast" use case. Reference register: GitBook / Vercel /
Linear-adjacent instrument-panel feel — never named in UI copy.

## Macrostructure family

This is a functioning app, not a marketing site — the 21 landing-page
macrostructures don't apply literally. Two structural families instead:

- **Auth pages** (Login, Register, Unlock, SharedFile): single centered
  hairline card, no chrome, no marketing copy. 6px radius, `--color-rule`
  border, max-width ~26rem.
- **App-shell pages** (Dashboard, Settings, HealthCheck): persistent sidebar
  (existing IA preserved) restyled with hairline dividers + mono uppercase
  labels, content panels are hairline-ruled "spec sheets" (Cobalt's F3
  discipline) rather than bordered cards, status/provider data renders as
  mono uppercase chips. A real ⌘K command palette (Cobalt signature move,
  net-new feature, user-approved) layers on top for jump-to-folder /
  jump-to-page / log out.

## Typography
- Display: Space Grotesk, weight 500/600, normal style, tracking -0.02em
- Body: Inter, weight 400/500
- Mono (outlier): JetBrains Mono — file sizes, hashes, IDs, status chips,
  Argon2/crypto params, command palette. ≤ 2 roles: (1) tabular/technical
  data, (2) small uppercase status labels.
- Scale anchor: `--text-display: clamp(1.75rem, 2vw + 1.25rem, 2.5rem)` — this
  app has no marketing hero, so display size stays modest (page titles, not
  landing headlines).

## Colour (OKLCH)
- `--color-paper`       oklch(98.5% 0.004 250)
- `--color-paper-2`     oklch(96% 0.006 250)
- `--color-paper-3`     oklch(93% 0.008 250)
- `--color-ink`         oklch(24% 0.02 258)
- `--color-ink-2`       oklch(34% 0.018 257)
- `--color-rule`        oklch(90% 0.006 250)
- `--color-rule-2`      oklch(84% 0.008 250)
- `--color-muted`       oklch(56% 0.014 255)
- `--color-accent`      oklch(58% 0.20 256)   (user-overridable — see Personalization)
- `--color-accent-ink`  oklch(99% 0.004 250)
- `--color-focus`       oklch(58% 0.20 256)
- `--color-graphite`    oklch(22% 0.016 260)  (one dark surface max per view)
- `--color-error`       oklch(58% 0.20 25)
- `--color-success`     oklch(60% 0.15 150)
- `--color-warning`     oklch(70% 0.15 80)

Accent occupies ≤ 5% of any viewport: active nav item, primary button,
focus rings, status chip fills, upload/health progress bars.

## Personalization (preserved feature)
`stores/theme.ts` keeps its user-facing accent picker, but presets become 6
OKLCH triples (accent / accent-hover / accent-ink) built in the same
L≈55-60% C≈0.16-0.20 envelope as Cobalt's default, so any pick still reads
"engineered." The picker overrides `--color-accent` / `--color-focus` /
`--color-accent-ink` at `:root` at runtime — Tailwind's generated utilities
(`bg-accent`, `text-accent`, `border-accent`) read the same custom property,
so the override cascades everywhere for free.

## Spacing
4pt scale, named tokens only (`--space-3xs` … `--space-4xl`, see tokens.css).
Never raw px in component code.

## Radii
`--radius-input: 6px` (buttons, inputs, chips-large) ·
`--radius-card: 10px` (panels, modals, code blocks) ·
`--radius-chip: 4px` (small mono status chips)

## Motion
- Easings: `--ease-out` cubic-bezier(0.16,1,0.3,1) · `--ease-in` cubic-bezier(0.7,0,0.84,0) · `--ease-in-out` cubic-bezier(0.65,0,0.35,1)
- Reveal pattern: one load-stagger on the file table only (≤ 400ms total,
  IntersectionObserver-free since it's an initial list, not a scroll reveal).
  No scroll-triggered animation anywhere else — this is a utility app.
- Reduced-motion fallback: opacity-only, ≤150ms.

## Microinteractions stance
- Silent success — no toasts on completed uploads/deletes/renames the user
  can already see resolved in the table. Toasts reserved for failures and
  background events (replication, health-check completion).
- Optimistic delete/rename + Undo toast, not confirm dialogs, for reversible
  actions. Destructive irreversible actions (permanent purge) keep a
  type-to-confirm dialog.
- Hover delay 800ms / focus delay 0ms on tooltips.
- Copy-to-clipboard (share links) swaps label to "Copied", no toast.

## CTA voice
- Primary: solid `--color-accent` fill, `--color-accent-ink` text, 6px
  radius, single specific verb ("Upload files", "Create folder", "Save
  changes") — never "Submit"/"OK".
- Secondary: `--color-rule-2` border, transparent fill, `--color-ink-2` text.
- Destructive: `--color-error` border/text, transparent fill until hover.

## Per-page allowances
- App-shell pages MUST NOT use hero enrichment — function carries the page.
- Auth pages: typography + hairline card only, no illustration.
- One `--color-graphite` dark band is allowed app-wide, not per-page — reserve
  it for the crypto/health detail expansion in HealthCheck, if used at all.

## What pages MUST share
- Sidebar wordmark ("DiscorDrive", Space Grotesk 600).
- Accent placement discipline (≤5%), CTA voice, input/button height (44px),
  6px radius on interactive controls.
- Mono treatment for any technical/tabular data (sizes, dates as tabular-nums,
  hashes, IDs, status).

## What pages MAY differ on
- Auth vs app-shell chrome (no sidebar on auth pages).
- Content layout inside the app shell (table vs. stat rows vs. form).

## Exports

### tokens.css
See `src/tokens.css` — the live Tailwind v4 `@theme` block is the source of
truth; the values above mirror it exactly.

### DTCG `tokens.json`
```json
{
  "color": {
    "paper":  { "$value": "oklch(98.5% 0.004 250)", "$type": "color" },
    "ink":    { "$value": "oklch(24% 0.02 258)", "$type": "color" },
    "accent": { "$value": "oklch(58% 0.20 256)", "$type": "color" }
  },
  "font": {
    "display": { "$value": "Space Grotesk", "$type": "fontFamily" },
    "body":    { "$value": "Inter", "$type": "fontFamily" },
    "mono":    { "$value": "JetBrains Mono", "$type": "fontFamily" }
  }
}
```
