# Accessibility (CMP-02)

EduOS targets **WCAG 2.2 level AA**. This document records what is checked
automatically on every change and what is not. It is **not** a conformance
claim or a VPAT: automated tools find only part of WCAG failures, and a
conformance statement needs the manual review listed at the end, done and
documented by a qualified reviewer.

## Checked in CI on every pull request

**Web app (`/app/`), `unit` job: `test/browser/app-smoke.test.js`.**
Headless Chrome, a mock API, every role and every tab (81 screens), plus
opened states: the SIS connector preview, a Time Capsule's detail, the
payments failure state and the webhook-URL dialog. Any finding fails the build.

| Check | Tool | WCAG |
| --- | --- | --- |
| Rules tagged A/AA for WCAG 2.0, 2.1 and 2.2, at desktop width and at 390 px | axe-core 4.14.1 | many (names, roles, contrast, labels, structure, target size 2.5.8, …) |
| Every focusable control shows a focus indicator | own check | 2.4.7 Focus Visible |
| A focused control is not hidden behind the sticky header or the fixed tab bar (desktop and 390 px) | own check | 2.4.11 Focus Not Obscured (Minimum) |
| No sideways scrolling of the page at 320 CSS px | own check | 1.4.10 Reflow |
| Every bottom tab is on screen or reachable by scrolling the tab bar | own check | 2.1.1 / 1.4.10 |

**Older pages and the full stack, `e2e` job: `dev/browser-smoke.mjs`.** The
axe scan of every role's main screens (WCAG 2.0–2.2 A/AA) runs against the real
stack. Until CMP-02 it was silently skipped in CI because axe-core was not
installed there; it is now installed and required (`EDUOS_REQUIRE_AXE=1`).

axe-core and playwright-core are not project dependencies. CI installs pinned
versions outside the project with install scripts disabled. Locally:

```sh
npm install --prefix ~/tools/a11y --no-save --ignore-scripts axe-core@4.14.1
EDUOS_AXE_PATH=~/tools/a11y/node_modules/axe-core/axe.min.js EDUOS_REQUIRE_BROWSER=1 \
  node --test test/browser/app-smoke.test.js
```

Without `EDUOS_AXE_PATH` the accessibility checks are skipped locally;
`EDUOS_REQUIRE_AXE=1` (set in CI) makes a missing axe-core an error.

### Fixed by CMP-02

- Keyboard focus scrolled controls behind the fixed bottom tab bar (65 screen
  groups). The page now has `scroll-padding` for the header and tab bar.
- On a phone, roles with many tabs (a principal has 10) had the last tabs
  pushed off the screen, so they could not be seen or tapped. The tab bar now
  scrolls sideways, each tab keeps a 64 px minimum width, and the current tab
  is kept in view.

## Already in the product

Skip link, `lang`, a focus ring on `:focus-visible`, live regions for toasts
and results, a per-user high-contrast theme, `prefers-contrast`,
`forced-colors` and reduced motion respected, and a server-side contrast gate
on school branding (text that fails AA cannot be published).

## Not covered by automation (manual review needed)

These need a person, with a screen reader and keyboard, before any
conformance statement:

- Screen reader passes (NVDA + Chrome/Firefox, VoiceOver on iOS and macOS,
  TalkBack) of each role's main journeys, including announcements of async
  results and errors (4.1.3).
- Keyboard-only completion of each journey, focus order (2.4.3), no keyboard
  traps (2.1.2), and focus return after dialogs.
- Meaningful text alternatives, headings and labels (axe checks they exist,
  not that they make sense).
- Contrast of text over images and in states the scan does not open (hover,
  error, disabled), and the high-contrast theme.
- Zoom to 200 % and text spacing (1.4.4, 1.4.12).
- WCAG 2.2 additions that need judgment: Dragging Movements (2.5.7),
  Consistent Help (3.2.6), Redundant Entry (3.3.7), Accessible Authentication
  (3.3.8) on the district sign-in.
- The Flutter mobile app and the edge/kiosk screens, which these scans do not
  reach.
- Content that districts and families add (uploaded documents, images,
  videos and their captions).
