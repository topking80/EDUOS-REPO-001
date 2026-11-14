EduOS District Edition 32.0.26 — Teacher Classroom Planner

Scope
- Adds a teacher-preference classroom planner to the existing home workspace.
- Supports room/floor selectors and four seating layouts: rows, pods, U-shape and groups.
- Lets a teacher select a preferred desk position and label their classroom.
- Saves and restores the preference in the current browser using localStorage.
- Includes a school-room index interaction and a safety checklist.

Safety and data boundaries
- The included floor plan and room geometry are illustrative UI templates, not surveyed building drawings.
- No real evacuation route, assembly point, fire equipment location, accessible egress or shelter location is asserted.
- The app explicitly requires approved school emergency plans and verified building drawings before operational use.
- This demo does not connect to a student roster or persist preferences to a district server.
- Do not place student-identifiable seating information in a shared browser profile.

Run
- Use the existing project setup: npm install, then npm test, then npm start.
- The package requires Node.js >=22 as declared in package.json.

Validation
- New focused tests: 4 passed.
- Inline JavaScript syntax check: passed.
- Full suite: 134 passed, 9 failed. The remaining failures are existing integration tests that import missing runtime dependencies (`cookie`, `jose`, and `pg`) in this environment; install project dependencies before interpreting those tests as runtime failures.
- No browser screenshot, live database, school plan, or emergency-procedure validation was performed.
