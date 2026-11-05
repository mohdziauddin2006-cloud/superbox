# Contributing

SuperBox is a small, opinionated project. Keep changes focused and prove them.

## Before you open a PR

1. Run the verify workflow locally where possible:
   - `node --check` on the JavaScript files you touched,
   - the Android CDP smoke checks in [tools/README.md](tools/README.md) if you
     changed the mobile UI,
   - a Windows smoke run if you changed the desktop shell.
2. Keep the two catalogues separate: **Spotlight** and **SuperBox Vault** are
   different worlds under one brand.
3. Do not add accounts, telemetry, ads, trackers or watch-history storage.
4. Do not commit keystores, passwords, `.env` files or build output.
5. For UI changes, attach a screenshot or a short recording.

## Style

- Match the surrounding code; no new frameworks without a reason.
- Android UI is plain JavaScript + CSS inside the WebView, not a bundler.
- Desktop is Electron with a narrow preload bridge.
- Keep user-facing strings in the SuperBox voice: short, calm, no hype.

## Commit messages

Use a short imperative subject and a body when the change needs context:

```
vault: keep drawer scroll at the top on reopen

The drawer reused its previous scroll offset after a close/open cycle.
Reset it in the same frame that adds .open.
```
