---
description: Run lint, typecheck, and test suite with structured failure summary
---

# Verify Workflow

Execute this workflow to verify code health, formatting, types, and test suites across all workspaces in HookRelay.

## Steps

1. Run lint check:
   ```bash
   npm run lint
   ```

2. Run typecheck across all project references:
   ```bash
   npm run typecheck
   ```

3. Run unit and integration tests:
   ```bash
   npm run test
   ```

4. If any step fails:
   - Parse and summarize all errors strictly formatted with `file:line` locations and failure messages.
   - Fix **only** failures directly related to the current task or recent edits.
   - Report any unrelated or pre-existing failures to the user without making unilateral modifications.
