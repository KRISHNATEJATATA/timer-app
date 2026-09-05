# Topic Timer — Implementation Spec

Authoritative handoff spec from the grilling interview (2026-09-01). Domain terms are defined in [CONTEXT.md](../CONTEXT.md); key architectural decisions in [docs/adr/](adr/). If this spec conflicts with idea.md, this spec wins — idea.md is the original raw idea.

## Product shape

- A single borderless desktop widget (~250px wide) that sits on the **desktop background layer**, like a Windows clock gadget. Other windows cover it. (Always-on-top and tray-icon models were considered and rejected by the owner.)
- No normal app window, no taskbar presence, no tray icon.
- Auto-starts with Windows via a shortcut in the user's Startup folder. The owner must never run a command manually.
- Right-click on the widget provides app exit.
- Built with Neutralino.js (~2MB binary, WebView2 runtime — see ADR-0001).

## Widget UI

The widget is the entire UI. It shows, on one small panel:

- **Topic text field** — where the owner types the topic name when starting.
- **Live elapsed clock** — current open Session's elapsed time (e.g. `01:23:45`), plus the topic name of the open Session.
- **Start / Pause / Stop buttons.**
- While paused, the Pause button is replaced by Resume, and **both Resume and Stop are visible**.
- At the Cap (12h), the Session auto-pauses and the widget shows a notice; the owner decides Resume or Stop.
- CSV export is triggered from the widget via a save dialog.

Idle state: topic field + Start available. Running state: clock + topic name + Pause/Stop. Paused state: clock frozen + Resume/Stop + cap notice if paused by Cap.

## Behavior rules

1. **Start is blocked** while the topic field is empty. No nameless sessions, no "untitled" default.
2. **One open Session at a time.** Start is unavailable while a Session is open.
3. A Session is **locked to the topic typed at Start**; no mid-session topic switching.
4. **Stop finalizes**: permanently writes the Session to the log. Stopped Sessions are never resumable.
5. **Pause preserves elapsed time**; time does not accrue while paused. Pause is a simple on/off toggle (no pause-while-paused).
6. **Cap = 12 hours of accrued time.** Reaching it auto-pauses the Session with a notice; owner then Resumes (accrual continues toward the cap again) or Stops. Sessions are never auto-stopped or discarded at the cap.
7. **Sessions may span midnight** (multi-day). They log as one Session with real start/end timestamps; no daily splitting.
8. **PC sleep/hibernate time counts** as elapsed. Plain wall-clock math; no sleep detection.
9. **Reboot / app death with an open Session**: on next launch the app detects the orphaned open Session and **asks the owner**: count all elapsed time / discard the Session / keep it open as-is (accruing through the gap).
10. **Topic matching is case-insensitive with surrounding whitespace trimmed.** "Email", "email", "email " are the same Topic. Topics are free text; no topic list or autocomplete management.

## Data

- **Log file**: human-readable JSON at `Documents\TopicTimer\` (see ADR-0001 for why JSON over SQLite).
- Proposed record shape (final schema is the implementer's call, keep it human-editable):

```json
{
  "topic": "Email",
  "startedAt": "2026-09-01T09:00:00",
  "stoppedAt": "2026-09-01T10:30:00",
  "elapsedSeconds": 5400
}
```

- The open (not yet stopped) Session is persisted continuously (or on every state change) so a reboot can be detected and the orphaned-Session prompt can offer accurate choices.
- **No in-app review, stats, or summaries** — see ADR-0002. The owner reads and edits the JSON directly (including deleting accidental entries).
- Stopped Sessions are immutable through the app: no edit or delete UI.

## Export

- **CSV export** via a save dialog. One row per Session: `topic, start, end, elapsed`. Must open cleanly in Excel.
- The JSON log file itself doubles as the backup; export exists purely for analysis.

## Environment facts

- Windows machine. Node v24.20.0 and npm 12.0.2 available. Python 3.13.14 available. No Rust toolchain (rules out Tauri without installing it).
- Project is greenfield: only idea.md, CONTEXT.md, docs/, and .agents/skills/ exist.
