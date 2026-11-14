# GitHub import — EduOS 37.3.0

From the extracted source root:

```bash
git switch -c release/37.3.0
git add .
git commit -m "EduOS 37.3.0 durable webhook outbox"
git tag -a v37.3.0 -m "EduOS 37.3.0"
git push -u origin release/37.3.0
git push origin v37.3.0
```

Apply database migration 033 in staging before deploying the application. Do not promote to production until the documented RLS, worker-concurrency, restart-recovery, and full-suite gates pass.
