---
name: verify
description: Verify the sample task app through its real user entry points on an exact build.
---

# VERIFY: sample task app

Product-owned verification skill for the slice-4 sample app. All five steps are
required, in order; `../verify.mjs` implements them for this app.

1. **Launch** the built `server.mjs --serve --data <scratch file>` on an owned
   loopback port with an empty, isolated store.
2. **Doctor** `GET /health`: the running revision, build digest and process ID
   must match the build under test. Repeat after any failure. A mismatch blocks.
3. **Drive** every entry point listed in the feature file through its route and
   handles. Never substitute one entry point for another.
4. **Evidence**: record the action and list result, then re-read the stored
   value through `../app/read-store.mjs` in a separate process.
5. **Cleanup**: stop only the launched process and remove only this run's
   scratch directory. Evidence lives in the evidence store, outside scratch.

## Feature index

```json
{
  "schema": "verify-feature-map.v1",
  "product": "sample-task-web",
  "features": [{ "id": "add-task", "file": "features/add-task.md" }]
}
```
