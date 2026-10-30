# Accounts menu: global Claude and Codex account switch

Approved in chat on 30 Oct 2026. Fork-only feature; upstream declines to build account switching.

## Goal

Switch the active Claude Code and Codex login for the whole Mac from T3 Code's macOS menu bar, as the
Raycast "Claude Switch" extension does today. Raycast, T3 Code and terminal `claude`/`codex` always agree,
because all of them use one switching implementation and one saved-accounts store.

Non-goals: per-thread or per-instance accounts, auto-rotation on usage limits, adding new accounts
from T3 (log in with the CLI, then "Save current login"), mobile/remote clients.

## Pieces

### A. `claude-switch` CLI (in `~/dev/claude-switch`, not in this repo)

`src/cli.ts` wraps the existing `src/lib/store.ts` (Claude) and `src/lib/codex.ts` (Codex). No Raycast
imports. `npm run build` also bundles it into one ESM file at `~/.config/claude-switch/cli.mjs`
(override with `CLAUDE_SWITCH_CLI_OUT`). It runs on plain Node 20+ and on Electron's Node
(`ELECTRON_RUN_AS_NODE=1`).

All commands accept `--json`. With `--json`, stdout holds exactly one JSON document, exit code 0 on
success and 1 on failure (`{"ok":false,"error":"<message for a person>"}`).

```text
cli.mjs list --json
cli.mjs switch <claude|codex> <profileId> --json
cli.mjs save <claude|codex> [--name <name>] --json
```

`list` output:

```json
{
  "ok": true,
  "claude": {
    "activeId": "c0b1dbf6",
    "current": { "loggedIn": true, "email": "a@b.c", "plan": "Max" },
    "profiles": [{ "id": "c0b1dbf6", "name": "Arcco", "email": "a@b.c", "plan": "Max" }]
  },
  "codex": {
    "activeId": "309d9a66",
    "current": { "loggedIn": true, "email": "x@y.z", "plan": "Plus" },
    "profiles": [
      { "id": "309d9a66", "name": "Jagat Postman Lab", "email": "x@y.z", "plan": "Plus" }
    ]
  }
}
```

`activeId` is the saved profile matching the current login, or `null`. `plan` is the existing
`planLabel` / `codexPlanLabel` text, or omitted. A provider whose state cannot be read reports
`{"error":"..."}` in place of its object, so the other provider still lists.

`switch` output: `{"ok":true,"provider":"claude","profile":{...},"alreadyActive":false}`. It calls the
existing `switchTo` / `switchCodex`, which re-save the outgoing login before swapping and back it up.

`save` output: `{"ok":true,"provider":"codex","profile":{...},"updated":false}` (existing
`saveCurrentLogin` / `saveCodexLogin`).

The existing `CLAUDE_SWITCH_*` environment overrides keep working, so tests and the T3 dev build can
point the CLI at scratch Keychain items and folders.

### B. Accounts menu (this repo, `apps/desktop`)

New `apps/desktop/src/window/DesktopAccountsMenu.ts`:

- Finds the CLI at `$T3CODE_ACCOUNT_SWITCH_CLI`, else `~/.config/claude-switch/cli.mjs`. Missing file:
  no Accounts menu at all (stock behaviour).
- Runs it with `process.execPath` and `ELECTRON_RUN_AS_NODE=1`, inheriting the environment, 10 s timeout.
- Builds an **Accounts** top-level menu (inserted before Window):
  - `Claude` submenu: one radio/checkbox item per profile, label `Name (Plan)`, checked when
    `id === activeId`; separator; `Save Current Login` (disabled when not logged in or already saved);
    a provider error shows as one disabled item with the message.
  - `Codex` submenu: same.
- On click: run `switch`, then rebuild the menu, show a macOS notification
  ("Claude: now Arcco (Max)"), and send menu action `accounts-switched` to the renderer.
  On failure: native error dialog with the CLI's message; menu rebuilt from fresh `list`.
- Refreshes its data when the app window gains focus (catches switches made in Raycast), debounced.
- Wiring into `DesktopApplicationMenu.ts` is kept to a few lines.

### C. Refresh after a switch (this repo, `apps/web`)

A small handler for menu action `accounts-switched` calls the existing `serverEnvironment.refreshProviders`
for the local environment, so provider account and usage displays update immediately.

## Behaviour

- Global: terminal `claude`/`codex` and other Claude Code sessions follow the switch.
- A running turn finishes on the account it started with. New threads and the next message of existing
  threads use the new account; history is kept because all accounts share `~/.claude` and `~/.codex`.
- Open question settled by one supervised real test: whether live Claude/Codex processes pick up the new
  login on their own. If not, follow-up work releases idle provider sessions after `accounts-switched`.

## Testing

- `claude-switch`: `npm run selftest` extended for `list`/`switch`/`save` on scratch Keychain items.
- T3: unit tests for menu building (labels, checks, missing CLI, provider error, click → switch → action).
- Live: `vp run dev:desktop` with `CLAUDE_SWITCH_*` pointing at scratch data; screenshot the menu.
- One real Codex and Claude switch with Garud present, then switch back.
- Build/install with `fork/update.sh --no-sync`; rollback per `fork/README.md`.
