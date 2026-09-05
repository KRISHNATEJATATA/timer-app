# Topic Timer — Dashboard Build Brief

You are building a **read-only dashboard website** that visualizes data logged by an existing desktop timer widget. This document contains everything you need: where the data lives, its exact schema and semantics, edge cases, and the features required. Do not modify the widget's code, `data/` folder contents, or `log.json` — the widget owns that file and rewrites it at session boundaries.

## Product context

- The widget lets the owner start/pause/stop timed sessions on named free-text topics and logs every finalized session.
- Domain glossary: [`../CONTEXT.md`](../CONTEXT.md). Architecture decisions: [`../docs/adr/`](../docs/adr/).
- The widget itself has **no** stats UI — the dashboard is the entire review/statistics surface (requirements 5–8 of the original idea).
- **Session model (ADR-0003):** a session ends (and is logged) when the owner presses Stop **or** Pause. Pause is *finalizing*, not a break inside a running session. Resume starts a **new** session on the same topic. A continuous block of work therefore appears as several back-to-back sessions, each with stable start/end/elapsed. There is no "open" session in the log, ever.

## Data source

Primary log file (authoritative, current after every finalize):

```
C:\Office\temp\timer\data\TopicTimer\log.json
```

The widget resolves its data folder at runtime with fallbacks, in order. On this machine the first one wins, but be aware the other two could theoretically hold data on a different machine:

1. `C:\Office\temp\timer\data\TopicTimer\log.json` (preferred, project folder)
2. `Documents\TopicTimer\log.json` (roamed OneDrive Documents — creation fails here, kept as fallback)
3. `%APPDATA%\TopicTimer\log.json`

Related files you may encounter in the same folder: `log.corrupt.bak` (the widget quarantines an unparseable log there and starts fresh) and `topic-timer-export.csv` (default export target).

## Exact schema of log.json

```json
{
  "open": null,
  "sessions": []
}
```

- **`sessions`** — array of finalized sessions, appended in finalize order (not guaranteed sorted; sort by `start` when displaying). Every entry was complete the instant it was written; the file is only rewritten when a session finalizes (Stop, Pause, or the 12-hour cap), so mid-write truncation is unlikely but still handle it.

```json
{
  "topic": "Email",
  "start": "2026-09-01T18:19:50+05:30",
  "end": "2026-09-01T18:19:54+05:30",
  "elapsedSeconds": 2
}
```

- **`topic`** — free text, trimmed, stored exactly as typed. Same topic = same name ignoring case and surrounding whitespace ("Email", "email", "Email " are one topic). Normalize with `trim().toLowerCase()` for aggregation, display the most recent casing the owner used.
- **`start`** / **`end`** — ISO 8601 **with local UTC offset** (e.g. `+05:30`). Always parse with `Date.parse`. Sessions may span midnight and multiple days.
- **`elapsedSeconds`** — integer seconds of accrued time. **Authoritative for all math.** Recomputing from `start`/`end` is only an approximation because paused-out gaps sit between a session's end and the next session's start. PC-sleep time never lands inside a session (the widget finalizes at the last tick before a >2min wake gap), but long real-time gaps *between* sessions (PC off, weekend) are normal and must never be attributed to any topic.
- **`open`** — normally `null`. The widget writes a snapshot (`{topic, startedAt, elapsedSeconds, savedAt}`) at most once per minute while a session runs, purely so an unclean exit can be recovered. A dashboard may encounter a non-null `open` while a session is literally running: treat it as "in progress, not yet final" — show it optionally as live data but **exclude it from totals** until it becomes a finalized `sessions[]` entry (it will, at pause/stop, and its elapsedSeconds then covers the same span).

## Real sample data

Current production log (one short test session):

```json
{
  "open": null,
  "sessions": [
    { "topic": "temp", "start": "2026-09-01T18:19:50+05:30", "end": "2026-09-01T18:19:54+05:30", "elapsedSeconds": 2 }
  ]
}
```

Realistic fixture covering the edge cases (use as a dev fixture, e.g. `dashboard/test-fixture.json`; do **not** write into `data/`):

```json
{
  "open": null,
  "sessions": [
    { "topic": "Email", "start": "2026-09-01T09:10:00+05:30", "end": "2026-09-01T09:55:00+05:30", "elapsedSeconds": 2700 },
    { "topic": "email", "start": "2026-09-01T14:00:00+05:30", "end": "2026-09-01T14:20:00+05:30", "elapsedSeconds": 1200 },
    { "topic": "Deep work", "start": "2026-09-01T22:00:00+05:30", "end": "2026-09-02T01:00:00+05:30", "elapsedSeconds": 10800 },
    { "topic": "  deep WORK ", "start": "2026-09-02T10:00:00+05:30", "end": "2026-09-02T12:30:00+05:30", "elapsedSeconds": 9000 },
    { "topic": "Code review", "start": "2026-09-02T15:00:00+05:30", "end": "2026-09-02T15:45:00+05:30", "elapsedSeconds": 2700 },
    { "topic": "Email", "start": "2026-09-03T09:00:00+05:30", "end": "2026-09-03T09:12:00+05:30", "elapsedSeconds": 720 },
    { "topic": "Meetings", "start": "2026-09-03T11:00:00+05:30", "end": "2026-09-03T12:30:00+05:30", "elapsedSeconds": 5400 },
    { "topic": "Deep work", "start": "2026-09-04T09:30:00+05:30", "end": "2026-09-04T17:00:00+05:30", "elapsedSeconds": 21600 },
    { "topic": "Meetings", "start": "2026-09-05T16:00:00+05:30", "end": "2026-09-08T09:30:00+05:30", "elapsedSeconds": 5400 }
  ]
}
```

Note what this fixture exercises: case/whitespace topic variants that must merge, a midnight-spanning session, and a long real-time gap between sessions (PC off / weekend) — gaps *between* sessions are normal and must never be attributed to any topic.

## Requirements (from the original idea, req 5–8)

1. **Per-topic totals** — total accrued time per topic, ranked. This is the headline view.
2. **Session review** — a table of all logged sessions (topic, start, end, duration) with sorting and filtering (by topic and by date range). Filter should operate on normalized topic names. A "work block" view (consecutive sessions on the same topic separated only by short gaps) is a nice extra given the pause-splits-sessions model.
3. **Summaries/statistics** — at minimum: overall totals (all-time time tracked, session count), **average session length per topic** and overall, per-day totals (a session spanning midnight may either be split across days by elapsed time or attributed to its start date — split is more truthful; your call, document it), and a trend view (daily bars for the last 14 days works well).
4. **Export** — the widget already exports CSV (`topic,start,end,elapsed_seconds,elapsed` rows, RFC 4180 escaping). A "download as CSV" button in the dashboard is a nice extra, not a requirement.

Display durations as `h:mm` or `h:mm:ss` (e.g. `1:30:00`), not raw seconds.

## Hard constraints

- **Read-only.** Never write to `data/`, `log.json`, or anything the widget owns. If the dashboard needs writable state, use its own folder (`dashboard/`).
- **Corrupt/empty tolerance.** The file can legitimately contain `{"open":null,"sessions":[]}` (fresh install) or, rarely, truncated JSON (rewrite at finalize). Retry once on parse failure; show a friendly empty state otherwise.
- **Refresh model.** The file changes at most once per minute while a session runs (minute-cadence persistence, ADR-0004), and once per finalize otherwise. A manual "Refresh" button is enough; if you poll, keep ≥30s intervals. Never hold the file open. Note `app.lock` in the data folder — a PID file the widget uses for single-instance enforcement; ignore it, never delete it.
- **Timezone.** Display timestamps in local time (they already carry the offset); do all bucketing in local days.
- **No server assumptions.** It must work as a static site. `fetch()` from `file://` will fail CORS — either inline the log into the page at build/snapshot time, use a file-picker/drag-drop input, or document `npx serve` for local HTTP. Choose one and make it obvious in a README.
- **Scope of tech is yours** — plain HTML/JS or a framework, Chart.js or similar for charts. Keep it a small static app in `dashboard/` (folder already created for you).

## Done means

- Opening the dashboard shows correct totals for the production log and the fixture (spot-check: fixture all-time total = 58,320s = 16h12m across the 6 normalized topics; "Deep work" = 41,400s = 11h30m, including the midnight-spanning session).
- Case variants merged; sessions sorted by start; durations rendered as h:mm:ss.
- Empty log, missing file, and truncated-JSON cases each show a sensible message instead of a blank page or a crash.
