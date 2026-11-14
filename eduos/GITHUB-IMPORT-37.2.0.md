# GitHub import — EduOS 37.2.0

Use a new release branch and preserve the existing repository history. Review the diff before committing; do not force-push or replace the default branch.

```bash
git switch -c release/37.2.0
# Copy archive contents into the repository root, then review:
git status --short
git diff --stat
git add -A
git diff --cached --stat
git commit -m "Fix EduOS connections and webhook reliability"
git tag -a v37.2.0 -m "EduOS 37.2.0"
git push -u origin release/37.2.0
git push origin v37.2.0
```

Open a pull request and wait for CI. Do not deploy to production until durable webhook delivery, database, security, and end-to-end gates are closed.
