# EdOS 37.4.0 import instructions

This branch is based on `main` and is intended for review before any merge.

## Current archive files

- `EDUOS_37.3.1_GitHub_Transfer_Kit.zip`
- `eduos-37.4.0-dns-retry-improvements.zip`

## Important

Do not extract either ZIP over the repository root without first inspecting its top-level paths. Do not overwrite `.git`, `.github` workflows, secrets, or environment files. Keep the existing `main` branch unchanged.

## In GitHub Codespaces terminal

1. Confirm the current branch:

   ```bash
   git branch --show-current
   ```

   It must print `integration/eduos-37.4.0`.

2. Inspect both archives:

   ```bash
   unzip -l EDUOS_37.3.1_GitHub_Transfer_Kit.zip | head -60
   unzip -l eduos-37.4.0-dns-retry-improvements.zip | head -60
   ```

3. Extract the transfer kit into a temporary folder first, then locate the original 37.3.1 source ZIP. Extract the source into a separate temporary directory. Extract 37.4.0 into another temporary directory.

4. Compare the two extracted trees before copying. Preserve existing project files and apply only the intended 37.4.0 changes. Do not copy secrets, `.env` files, build output, `node_modules`, or local credentials.

5. Review the staged changes:

   ```bash
   git status --short
   git diff --stat
   git diff --check
   ```

6. Run the project's documented tests and checks. Do not merge if tests fail or if the diff contains unexpected deletions.

7. Commit to this integration branch only:

   ```bash
   git add -A
   git commit -m "Integrate EdOS 37.4.0 DNS retry improvements"
   git push -u origin integration/eduos-37.4.0
   ```

8. Open a pull request from `integration/eduos-37.4.0` into `main` after review. Do not force-push or merge automatically.
