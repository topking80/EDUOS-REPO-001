# EduOS 32.3.0: school branding (mascots, school colors, icon displays)

What was asked: let each school design its own icon displays from its mascot
and school colors, for teachers, students and parents to see. This report
covers what was built, how uploads are kept safe, how it was checked, and what
was not checked. Operator actions are in `docs/UPGRADING-32.3.0.md`.

## 1. Branding profile per school
- One profile per school, plus a **district default**. Any field a school
  leaves empty is taken from the district default, then from the EduOS default.
- Fields: mascot name, mascot image, primary, secondary and accent colors, an
  optional font and an optional motto.
- Fonts come from a fixed list of system font stacks (System, Rounded, Serif,
  Slab, Extra readable). No web fonts are downloaded, so the CSP is unchanged.
- Who can edit:
  - a **principal**, for their own school only;
  - a **superintendent** or **IT admin**, for any school and for the district default.
  - Everyone in a school can read its **published** branding. Teachers,
    students and parents never see drafts.
- These rules are enforced twice: in the API, and in PostgreSQL row-level
  security (migration 011, FORCE RLS; the runtime role is not the table owner).
  `eduos_can_edit_branding()` allows the owner, district roles, or a principal
  whose session school matches the row. `eduos_in_branding_scope()` limits
  reads to the district default and the session's school.

## 2. Icon display designer (the "School branding" tab)
- Shown to principals, superintendents and IT admins.
- **Scope picker.** Principals see only their own school. District roles see
  every school plus "District default".
- **Identity:** mascot name, motto and font.
- **Mascot upload** (PNG, JPG, WebP or SVG), with remove.
- **Colors:** a color picker plus a hex field for each color. For a school,
  "Use the district color" clears the value so it is inherited.
- **Presets:** Mascot classic (school-color tiles with a mascot badge), Bold
  colors (square tiles cycling through the three colors, full-color icons) and
  Minimal (white tiles, icons in the primary color).
- **Per-tile editing.** "All tiles" sets the base style. Picking one tile
  (My work, Attendance, All apps, or any app available to that school)
  overrides that tile only. Settings:
  - shape: rounded, circle or square;
  - background, from the palette or a custom hex;
  - icon style: one color or full color;
  - icon color and label color;
  - icon (9 built-in glyphs drawn for EduOS);
  - label text (up to 40 characters);
  - hide the tile;
  - mascot badge.
  - "Undo changes to this tile" clears the override.
- **Live previews** for Teacher, Student, Young student (K-2) and Parent. They
  update on every keystroke and use the same rendering code as the live
  screens.
- **Lifecycle:**
  - Save draft. Drafts are visible only to editors.
  - Publish. This creates a new version and archives the previous one.
  - Discard draft.
  - Reset to district default, or to the EduOS default for the district
    profile. This creates a draft that inherits everything; it applies when
    published.
  - Version history with **Restore into draft**, then Publish.

## 3. Accessibility guardrails
- **Automatic WCAG 2.1 contrast checks.** Every text or icon color is checked
  against its background on every change, for every tile the school can show
  (built-in tiles plus its real apps). Pairs checked:
  - header text on the primary color, home-banner text on the secondary
    color, and text on the accent color;
  - each tile's label (text, needs 4.5:1);
  - each tile's icon or icon circle, and the edge of a white tile on the page
    (non-text, needs 3:1).
- **Warnings with a fix.** Each failing pair shows its ratio and the nearest
  passing shade, found by HSL lightness search in whichever direction is
  closer. A "Use suggested shade" button applies it. Identical failures on
  several tiles are grouped, so one click fixes all of them. For header,
  banner and accent problems, the suggestion adjusts that school color.
- **Publishing is blocked** by the server (`422 contrast_failed`, with the
  report) if any **text** pair fails AA. Icon-only problems are warnings. The
  check runs in the API from the same shared code (`public/eduos-contrast.js`,
  `public/eduos-brand-model.js`), so it cannot be skipped by a modified browser.
- **Automatic text color.** Text that sits on a school color is white or dark
  ink, whichever contrasts more. A failure therefore only happens when a
  color is explicitly chosen, or when a mid-tone school color passes with
  neither.
- **High-contrast override.** Every signed-in user has a **High contrast**
  button in the header (`aria-pressed`). It is saved per user
  (`PUT /api/me/preferences`) and replaces the school colors with black and
  white. `prefers-contrast: more` applies the same theme automatically;
  `forced-colors` (Windows High Contrast) keeps system colors with visible
  borders. `prefers-reduced-motion` and the saved `reduceMotion` preference
  turn off transitions.

## 4. Where branding appears
- **Header bar:** school color, mascot and school name chip, and the school font.
- **Home for every role:** a banner on the secondary color with the mascot,
  "Welcome to <school>", "Home of the <mascot>" and the motto. Teachers,
  students, parents and principals also get shortcut tiles.
- **Launcher tiles:** each app tile uses the school's tile design, including
  label overrides and hidden tiles.
- **K-2 view:** a large mascot banner ("Hi, Leo!"), big branded My work and
  Attendance tiles, and big app tiles.
- **Guardian portal:** the parent's Home uses the school's banner, shortcuts and tiles.
- **Active tab:** highlighted with the accent color.
- **Sign-in landing:** when the school is known (`/?school=<districtId>.<schoolId>`,
  or the last school used on that browser), the sign-in page shows the school
  name, mascot and colors. It uses a public, **published-only** endpoint.
- **Favicon, Apple touch icon and PWA manifest per school**
  (`/api/public/branding/<d>/<s>/icon-{32,48,96,180,192,512}.png` and
  `manifest.webmanifest`). Schools without a mascot get a generated star icon
  in their primary color.
- **People in several schools** see the branding of the school currently
  selected in the role/school switcher. The page reloads after switching.

## 5. Backend and data
- **Migration** `db/011_school_branding.sql`:
  - `branding_uploads`: source type, SHA-256, a record of what the sanitizer
    removed, uploader;
  - `branding_assets`: only processed output is stored, never the original upload;
  - `branding_profiles`: status draft/published/archived, version, contrast
    report, `based_on_version`. Unique indexes allow one draft and one
    published profile per scope;
  - `user_preferences`;
  - RLS on all four tables. Grants: uploads and assets are insert-only for the
    runtime role, and only drafts can be deleted.
- **API** (`src/branding-routes.js`):

  | Method and path | Purpose |
  |---|---|
  | `GET /api/branding/current` | The selected school's published branding |
  | `PUT /api/me/preferences` | Save the user's display preferences |
  | `GET /api/branding/scopes` | Schools (and district default) the user can edit |
  | `GET /api/branding/:scope` | The designer view for one scope |
  | `PUT /api/branding/:scope/draft` | Save the draft |
  | `POST /api/branding/:scope/mascot`, `DELETE /api/branding/:scope/mascot` | Upload or remove the mascot |
  | `POST /api/branding/:scope/publish` | Publish the draft |
  | `POST /api/branding/:scope/restore` | Copy a published version into the draft |
  | `POST /api/branding/:scope/reset` | Start an inheriting draft |
  | `DELETE /api/branding/:scope/draft` | Discard the draft |
  | `GET /api/branding/assets/:upload/:variant` | Serve a processed mascot image |
  | `GET /api/public/branding/:d/:s` (plus `/icon-N.png`, `/manifest.webmanifest`) | Public, published-only branding, rate-limited |

- **Webhook / flow event** `branding.published`, emitted after the
  transaction commits and delivered to webhook subscribers. Its references are
  ids only.
- **Audit** (`resource_type = 'branding'`): `draft.save`, `mascot.upload`
  (with type, SHA-256 and what was removed), `mascot.remove`, `publish`
  (version and warning count), `restore`, `reset`, `draft.discard` and
  `preferences.update`.
- **Demo seed:**
  - District default: navy, teal and gold, Minimal tiles.
  - **Riverside Elementary "Otters"**: river blue #1b4f8a, teal #0f7c80, gold
    #f6c445, Rounded font, Mascot classic tiles.
  - **Lincoln Middle "Lynx"**: maroon #6b1d2a, forest #2d4a3e, amber #e0a526,
    Slab font, Bold tiles.
  - The otter and lynx mascots are **original SVG drawings made for this
    release** from basic shapes, not copyrighted logos. They are processed by
    the same sanitizer and re-encoder as real uploads.

## 6. Upload security
- **The file type comes from the bytes**, never from the Content-Type or the
  file name. Only PNG, JPEG, WebP and SVG are accepted; GIF, PDF, HTML and
  anything else get `unsupported_type`.
- **Size:** at most `BRANDING_UPLOAD_MAX_KB` (default 2048, range 64–10240),
  enforced by the body parser (413). The body is read only after the session,
  CSRF and permission checks.
- **Raster images** (sharp/libvips):
  - `limitInputPixels` 4096×4096; at least 64 px on each side;
  - 10 s timeout; one thread and no cache, to keep memory modest;
  - EXIF orientation is applied, then the image is **re-encoded to PNG**. This
    drops EXIF, GPS, XMP, ICC and any trailing bytes (polyglots);
  - square crops at 512, 192, 180, 96, 48 and 32 px.
  - Corrupt or truncated files return `undecodable`. Tested: an EXIF marker
    present in the input is absent from every output.
- **SVG** (`src/svg-sanitize.js`):
  - A strict **allowlist** parser that re-serializes the file from scratch.
    Nothing from the input is passed through as-is.
  - Rejected outright: DOCTYPE and ENTITY (XXE and "billion laughs"), CDATA,
    processing instructions, unknown entities, malformed or mismatched
    markup, a root element other than `<svg>`, more than 5000 elements,
    nesting deeper than 32, and files over 256 KB.
  - Removed, and reported to the user and the audit log:
    - `script`, `foreignObject`, `use`, `image`, `a`, `style`, animation
      elements and `feImage`;
    - every `on*` handler, `style`, `class`, `href`/`xlink:href` and every
      namespaced attribute;
    - `url()` values other than `url(#local-id)`;
    - any value containing `javascript:`, `data:`, `vbscript:`,
      `expression(`, `@import`, backslashes or angle brackets. Entities are
      decoded first, so `&#106;avascript:` is caught.
  - The sanitized SVG is then rasterized to the same PNG sizes. The UI only
    ever shows the PNGs.
- **Serving:**
  - Processed assets are served with
    `Content-Security-Policy: default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox`,
    `X-Content-Type-Options: nosniff` and private caching.
  - Assets are visible only within the tenant and school scope (RLS). Another
    school's upload returns 404.
  - Public endpoints read only published rows. They run under an
    `anonymous` RLS role scoped to that school.
- **Rendering:** every value in the UI is escaped. Colors are validated hex,
  and labels, mottos and mascot names refuse `<` and `>`. The tile JSON is
  validated against a fixed schema: known keys, at most 200 overrides, and at
  most 64 KB stored.

## Results (Tuesday Nov 10, 2026, EST, on the box)
| Check | Result |
|---|---|
| Unit tests (`npm test`) | **303 pass**, 0 fail. This includes 7 new branding tests: 16 malicious SVG samples, 11 refused SVG inputs, WCAG reference ratios (#767676 on white = 4.54, #777777 = 4.48, blue = 8.59), suggested shades, EXIF stripping and orientation, size, pixel and type limits, model validation, and migration and grant contracts |
| PostgreSQL integration (`test/integration/*.test.js`, PostgreSQL 16, non-owner runtime role) | **49 pass**, 0 fail. 7 are new branding tests: who can edit; RLS blocking a principal writing another school's row and a teacher reading drafts; draft → publish → restore → reset lifecycle with audit rows and `branding.published` webhook deliveries; the AA publish block (422) with suggested shades; upload processing and refusals; public endpoints that expose published data only; the per-school view for a user in two schools; private preferences |
| HTTP smoke (`make smoke`, full Docker stack) | **31/31**. The new step: a principal can't brand another school and a teacher can't edit at all; low contrast is blocked; an SVG upload is sanitized; publishing works; teacher, student and parent see the new version; public JSON, icon and manifest; restore and republish of the seeded design; audit entry |
| Browser smoke + axe (headless Chrome) | **34/34 steps**. **axe WCAG 2.1 A/AA: 0 violations on 38 scans**, including every branded home, the designer, the high-contrast theme and the branded sign-in page. During the deliberate low-contrast attempt, axe flags the failing preview (proving it agrees with our math), the rest of the designer has 0 violations, and the server refuses to publish (422) |
| Edge checks | Python unit tests 30 OK; `make check` (butane --strict) OK |
| Release artifacts | See "Artifacts" below |

Screenshots are in `/workspace/eduos-screens/32.3/`:
- `30-branding-designer.png`: the designer.
- `31-preview-{teacher,student,young-student,parent}.png`: previews per role.
- `32-contrast-warning.png`: the live contrast warning with a suggested shade.
- `33-publish-blocked.png`: the server refusing to publish.
- `34-published-designer.png`: the designer after publishing.
- `35-published-{teacher,student,young-student,parent}-home.png` and
  `35m-published-young-student-home-mobile.png`: the published views.
- `36-student-high-contrast.png`: the high-contrast theme.
- `37-signin-landing-branded.png`: the branded sign-in page.
- `38-restore-into-draft.png`: a version restored into the draft.
- `axe-report.json`: empty, meaning 0 violations.
- The other files are the existing role screens, re-taken with branding applied.

## Not verified
- **Browsers:** only Chrome. Safari and Firefox rendering, the iOS
  "Add to Home Screen" icon, and installing as a PWA on devices were not tried.
- **Contrast and motion modes:** `forced-colors`, `prefers-contrast: more`
  and `prefers-reduced-motion` were implemented in CSS but not emulated in a
  test. The user high-contrast toggle was tested.
- **Screen readers:** no screen-reader pass was done (NVDA, VoiceOver). Only
  axe was used.
- **Decoder hardening:** no fuzzing of libvips/librsvg beyond the malicious
  samples above. The Docker image uses sharp's bundled libvips; keep it
  updated.
- **Text in SVGs:** SVG `<text>` is allowed, but the Alpine image has no fonts,
  so text inside an uploaded SVG does not appear in the PNGs. Shapes render
  normally.
- **Sign-in landing privacy:** the landing knows the school only from
  `?school=` or the last school used on that browser (localStorage holds the
  two ids, nothing personal). Host-name-based detection per school was not built.
- **Rollback** of migration 011 was not tested.

## Artifacts
See the parent report for the regenerated `/workspace/eduos-32-fixed.zip` and
`/workspace/eduos-32-fixes.patch`. Both are verified by applying the patch to
the baseline, comparing it with the zip, and running the unit tests in the
extracted tree.
