# 32.0.43 — Staffing & Sections (principal hiring + teacher enrollment)

Adds a new **Staffing & Sections** workspace to the served demo app
(`public/index.html`), implementing the three requested behaviors.

## What was added
1. **Principal can hire up to 100 teachers.** A hire form (name, subject, grade,
   school) with a live `N / 100` counter. At 100 the form is replaced by a
   "Hiring cap reached" notice and `hireTeacher()` refuses to exceed the cap.
   Principals can also create class sections and remove teachers (empty sections
   only). A Teachers table shows each teacher's section and enrollment counts.
2. **Teacher can enroll up to 50 pupils per class.** A section picker + enroll
   form with a live `N / 50` counter and progress bar. At 50 the form is replaced
   by a "Class full (50 / 50)" notice and `enrollPupil()` refuses to exceed the
   cap. Each section's roster is listed with per-pupil removal.
3. **Each section updates based on enrollment.** Every section row shows
   `enrolled / capacity`, a status pill (Empty / Open / Filling / Full) and a
   capacity bar, all recomputed from the roster on each render — so counts move
   the moment a pupil is enrolled or removed. The Superintendent gets a
   read-only district oversight view of the same live data.

## How it is wired (no breakage)
- One new page key `staffing` added to `renderers`, `pageNames`, `navIcons`, and
  to `roleMenus` for **superintendent, principal, teacher** only (parent/pupil
  do not get it). `personaConfig` is derived from `roleMenus`, so access stays
  consistent automatically.
- New state lives in its own store (`localStorage: eduos_staffing_v1`), seeded
  with 3 teachers and 3 empty sections; existing `data`/`learning` stores are
  untouched. All helper names are `stf`-prefixed; no identifier collisions.
- Actions are persona-gated (teacher cannot hire; principal cannot enroll) and
  write to the existing append-only demo audit log. Caps are demonstration
  guardrails, not a security boundary — persona switching is not authentication.

## Validation (real Chromium, served over HTTP)
- **Navigation audit** (`profile-nav-audit.cjs`): 98 links across 5 personas,
  **0 broken, 0 model issues, 0 loops**; superintendent 33/33, principal 26/26,
  teacher 15/15, parent 13/13, pupil 11/11; renderers/pageNames now 35.
- **Functional test** (`staffing-functional.cjs`): **13/13 pass** —
  hire adds a teacher and shows in the table; **cap 100 enforced** (form→notice,
  100→100 blocked); enroll updates a section 0→1 and shows "1 / 50" live;
  **cap 50 enforced** ("Class full", 50→50 blocked); teacher cannot hire;
  principal cannot enroll; no uncaught JS errors.

## Reproduce
```
# serve public/ on :8099, then:
node profile-nav-audit.cjs http://127.0.0.1:8099/index.html   # links/loops
node staffing-functional.cjs                              # caps + live updates
```
