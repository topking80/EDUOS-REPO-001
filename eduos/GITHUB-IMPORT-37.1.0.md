# GitHub import guide — EduOS 37.1.0

Import the source into a new branch in the existing `topking80/edos` clone. Preserve the repository history and compare existing files before resolving conflicts.

```bash
git switch -c release/37.1.0
# Copy the contents of this archive into the repository root.
git status --short
# Review all changed/deleted files before staging.
git add -A
git diff --cached --stat
git commit -m "Add EduOS 37.1.0 staff management workspace"
git tag -a v37.1.0 -m "EduOS 37.1.0"
git push -u origin release/37.1.0
git push origin v37.1.0
```

Open a pull request into the default branch. Do not force-push or replace the default branch. Do not deploy to production until the outstanding test, database, browser, security, and acceptance gates are closed.
