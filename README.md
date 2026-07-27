# chud

Always-on-top macOS HUD for your AI coding sessions. One card per session —
Claude Code and GitHub Copilot CLI — with live status, so you always know
who's working, who's waiting on you, and where.

## What a card shows

- **cmux tab name** (exact — resolved from each agent process's environment),
  falling back to the project folder
- **Status**: `NEEDS INPUT` / `WORKING` / `DONE` / `IDLE` — hook-driven for
  Claude; screen-verified for Copilot (the tab's own status bar is read, since
  Copilot only writes to disk at turn boundaries)
- **`LIVE` badge** when the agent process is still open
- **localhost port chips** for dev servers the session owns — click to open
- Last prompt, last reply, branch, and time since last prompt/finish
- **Click a card** to open a live mirror of that terminal — full colour, cursor,
  and mac line-editing chords (⌘⌫, ⌥⌫, ⌘←/→, ⌥←/→), typed straight back into the
  real session (toggle in ⚙ settings; when off, a click jumps to the cmux tab)

Active + recent sessions show by default; older ones collapse behind a toggle.

## Run

```sh
npm install
npm start
```

The window starts at the top-right of your active display.

**Hotkeys** (configurable in ⚙): `⌃⇧Space` focus the HUD, `⌃⇧H` hide/show.

## Wiring

- **Claude Code** — hooks POST to `http://127.0.0.1:4471`. In
  `~/.claude/settings.json`, add an `http` hook to `/event` on
  `SessionStart` / `UserPromptSubmit` / `Stop`, plus a command hook that sends
  `{session_id, path: $PATH, tty}` to `/env` (identifies the exact cmux tab).
- **Copilot CLI** — polled from `~/.copilot/session-store.db`, no setup.
- **cmux** (optional) — tab names, click-to-focus, and screen-verified status.
  Set `automation.socketControlMode: "password"` + `socketPassword` in
  `~/.config/cmux/cmux.json`. Without cmux everything else still works.

## Debug endpoints

```
GET /state     current sessions as JSON
GET /refresh   full re-scan (also the ⟳ button)
GET /audit     reads every cmux tab's real screen vs what the cards claim
GET /agents    live agent processes (pid, tab, cwd)
```

`/audit` is the trust check: if the HUD ever looks wrong, it prints
screens-vs-cards so you can see which one is lying.
