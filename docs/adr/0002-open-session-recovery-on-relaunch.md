**Status:** superseded by ADR-0003 — sessions now finalize on Pause/Stop, so no open session ever crosses a shutdown.

# Open sessions survive shutdowns via persisted elapsed and a recovery prompt

An open session's state (topic, startedAt, accrued elapsed, paused flag, cap-triggered flag) is rewritten to `log.json` about once per second, so a crash, reboot, or forced exit never loses more than a second of bookkeeping. On relaunch, if an open session is found, the app asks the owner instead of guessing: "Count all & stop" finalizes the session including the time the process was dead; "Keep open" continues the session from its persisted elapsed with the dead gap excluded; "Discard" drops it. While the app is alive, wall-clock accrual counts PC sleep time by design (ADR in the opposite direction was rejected as requiring native power-event hooks), but the dead-process gap is never counted silently.
