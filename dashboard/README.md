# Topic Timer — Dashboard

A read-only, static dashboard for the Topic Timer widget: per-topic totals, trend
chart, calendar heatmap, session review, work blocks, and summaries. Plain
HTML/JS/CSS with a vendored Chart.js — no build step, no server, no dependencies.

## Open the dashboard

**Local, no install:** just double-click `index.html`. Then click
**Open log.json…** and pick `data/TopicTimer/log.json` (or drag the file onto the
page). The file is parsed in your browser — nothing is uploaded anywhere.

In Chrome/Edge the choice is remembered (File System Access API): on your next
visit click **Refresh**, allow access when the browser asks, and you're current.

**Local over HTTP (optional):**

```
cd dashboard
npx serve .
```

**Hosted:** the site deploys to GitHub Pages (`.github/workflows/deploy-dashboard.yml`
publishes only this `dashboard/` folder — `data/` is never pushed to the site).
On the hosted page, use **Open log.json…** / drag-drop exactly as locally; your
log stays on your machine.

## What it shows

| View | Contents |
| --- | --- |
| Topics | Ranked totals + per-topic sessions/average |
| Trend | Daily bars, 7/14/30-day toggle, Total or stacked By-topic mode (per-topic segments use the same topic colors as the calendar donut; midnight-spanning sessions are split across days exactly like the calendar buckets) |
| Calendar | Month/week calendar styled after [shadcn/ui's Calendar](https://ui.shadcn.com/docs/components/base/calendar) (vanilla port — same caption/nav/weekday/day-button structure and states); tracked time shows under each day; click a day for its sessions |
| Sessions | Full log; sortable; filter by topic and date range |
| Work blocks | Consecutive same-topic sessions with gaps ≤ 15 min merged |
| Summaries | Per-day, per-week (ISO, Mon-start), per-month totals |

CSV export (top right) downloads the loaded sessions in the widget's export
shape: `topic,start,end,elapsed_seconds,elapsed`.

A live "in progress" banner appears when the log's `open` snapshot is non-null.
It is clearly labeled and **excluded from all totals**, per the session model
(ADR-0003): only finalized sessions count.

## Semantics

- **`elapsedSeconds` is authoritative** for every number on the page.
  `start`/`end` are display and bucketing only.
- **Topics** are matched case-insensitively after trimming
  (`"Email"`, `"email"`, `"Email "` are one topic) and displayed with the most
  recent casing you used.
- **Midnight-spanning sessions are split across local days** proportionally to
  wall-clock time (a 22:00→01:00 session adds 2 h to the first day, 1 h to the
  second). Chosen over "attribute to start date" because day totals then
  reflect when the work actually happened. The Sessions table still shows each
  session as a single row, and the split only affects day/week/month buckets —
  topic totals and the all-time total always use the raw `elapsedSeconds`.
- **Gaps between sessions are never attributed to any topic** (PC off,
  weekends, paused-out time).
- Timestamps carry a UTC offset in the log; all display and day-bucketing uses
  your browser's local timezone.
- Durations render as `h:mm:ss`.

## Robustness

- Fresh install (`{"open":null,"sessions":[]}`) → friendly empty state.
- Truncated/corrupt JSON → one automatic re-read retry, then a friendly error
  (the widget quarantines corrupt logs as `log.corrupt.bak` and starts fresh).
- Malformed individual session entries are skipped and counted, never fatal.
- The dashboard is strictly read-only: it never writes to `data/` and knows
  nothing about `app.lock`.

## Tests

```
node dashboard/test.js        # from the repo root; also wired as `npm test`
```

Covers topic normalization, midnight splitting, work-block merging, weekly and
monthly bucketing, duration formatting, and the empty/corrupt/open-snapshot
parsing paths against the edge-case fixture in `test-fixture.json`.
