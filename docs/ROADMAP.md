# Flowdo — roadmap

Flowdo is a Pomodoro **and** Flowmodoro time tracker with projects and tasks. Pomodoro counts
down a fixed focus block; Flowmodoro counts up for as long as you stay in flow and earns you a
break proportional to the time you put in. You can switch between the two without losing a
running session.

This document is the plan of record. It is a personal project, so the ordering reflects what is
most useful to build next rather than any release commitment.

---

## Shipped

### v0.1.0

Both timer modes with a working toggle; projects and tasks with estimates, priorities, due dates
and subtasks; drag-to-reorder and a completed-task view; every session persisted to SQLite; a
tray icon that shows live state; phase-end notifications; an always-on-top mini widget; global
hotkeys; and a Windows installer.

The timer runs in the main process and derives elapsed time from wall-clock anchors rather than
by accumulating ticks, so it survives background throttling and machine sleep. A suspend longer
than the configured grace period marks the session interrupted and subtracts the gap — sleeping
for an hour is not an hour of focus.

### v0.2 — seeing your history

v0.1 records your focus history and gives you no way to look at it. The statistics layer exists
and is exercised on every session; there is simply no screen for it. Likewise, settings are
honoured but cannot be changed outside of a developer console.

- **Stats page** — today / week / year / all, with a daily chart, per-project breakdown, a
  Pomodoro-vs-Flowmodoro split, and a streak.
- **Settings screen** — every duration and toggle, including rebindable hotkeys that tell you
  when a combination is already taken by another application.
- **Session history, with delete** — a mis-logged session otherwise skews every total above it.
- **JSON export and import** — your history should not be trapped in a single database file.
  Import replaces rather than merges, and writes a timestamped backup first.
- **Taskbar progress** — glanceable progress without raising the window.
- **A resizable layout** — the panels are currently fixed. Drag the dividers, collapse the ones
  you don't want, and the arrangement persists across restarts. The window remembers its size
  and position too.

### v0.3 — Todoist, Google Calendar, and a calendar screen

Pull real work in rather than retyping it, and see the day you actually have before deciding
what to focus on next. This moved ahead of the Linux port because it's the pair of features most
likely to change how the app gets used day to day.

- **Todoist, two-way** — tasks and subtasks sync both ways using your personal API token; edits
  reach Todoist within seconds. Projects come from Todoist and are read-only in Flowdo. Completing
  a recurring task advances it, as in Todoist. A task deleted upstream is marked rather than
  removed, and you choose whether to keep it. Disconnecting converts synced tasks to local ones
  and never touches the time already logged against them.
- **Today and Upcoming** — the task list opens on what is due today, overdue first and then by
  time, with the next seven days one click away.
- **Google Calendar, read-only** — via a calendar's "Secret address in iCal format", no OAuth.
  Events are cached roughly six weeks back and four months ahead.
- **Calendar screen** — Day, Week and Month views of the sessions you actually worked alongside
  your calendar events.
- **Two time zones at once** — when a task or event was set in a different time zone than your
  computer's, both times are shown, e.g. "07:15 Tehran · 07:45 local".
- **Daily backup** — a copy of your data from each of the last 14 days.
- **Credentials stored through the operating system's secure storage.** Where no secure backend
  is available, Flowdo declines to store the secret rather than fall back to plain text. Tokens
  and calendar addresses never leave the main process and are never included in an export.

### v0.3.1 — calendar details, and a mini clock on minimize

- **Weekday names on dates** — the Week heading, the Upcoming day groups, a task's due date,
  session history and the daily chart all say which day of the week a date falls on.
- **Choose the first day of the week** in Settings, Sunday through Saturday (Monday by
  default). The Week and Month views follow it, and so does the Stats "This week" range.
- **The mini widget appears when you minimize** — or close to the tray — sitting in the
  bottom-right corner of the screen until you bring the window back. Drag it anywhere and it
  remembers the spot. On by default; a Settings toggle turns it off, and pinning the widget
  keeps it open regardless.

### v0.4 — Linux, and automatic updates

Windows CI and automatic releases arrived early, with 0.3.1: every change is typechecked,
tested, built and driven end to end on Windows before it can merge, and a release publishes
itself once that gate passes. v0.4 finished the job.

- **Linux packages** — an AppImage and a `.deb`, alongside the Windows installer and portable
  build, built and smoke-tested in CI on every run. Launch at login works via an XDG autostart
  entry, since `setLoginItemSettings` is a no-op on Linux. The font stack gained Cantarell,
  Ubuntu and Noto Sans. Global hotkeys are unavailable under Wayland; the app says so rather
  than appearing to accept a binding that will never fire.
- **Automatic updates** — the Windows installer and the Linux AppImage check GitHub Releases
  at start and every 6 hours, download in the background, and install on the next restart,
  never interrupting a running session. Settings → Updates shows the version and status, with
  a manual check, a toggle, and a restart-to-update button. The portable exe and the `.deb`
  don't self-update; Settings says so and links to the releases page. As the first version
  with the updater, 0.4.0 itself has to be installed manually once — every release after it
  updates on its own.
- **A stricter standards gate** — every change now runs a dependency-free script that enforces
  the project's invariants (no hard-coded colours outside the token file, no fixed widths in
  components, no `toISOString()` in renderer code, no imports across process boundaries), plus
  `npm audit`, CodeQL and secret scanning, on Windows and Linux both, before it can merge or
  release.

---

### v0.4.1 — the mini widget behaves on Windows

- The mini widget could stay stuck open after a quick minimize and restore on Windows; it now
  follows the window's real state.
- A widget dragged just before quitting keeps its new position.

## Next

### v0.5 — making it yours

- **Light theme** — following the OS by default, overridable in Settings.
- **Real notification sounds**, replacing the current system beep.
- **Layout, continued** — reorder the panels, a compact density mode, and a resizable mini widget.

### v0.6 — your data, your call

Deleting your data should be as deliberate and as easy as exporting it.

- **Delete everything** — one place in Settings that removes your history, settings, backups
  and stored credentials, after offering an export first.
- **Delete a range of history** — sessions between two dates, optionally for one project, with
  a preview of exactly what goes before anything does.
- **Purge integration data** — disconnecting Todoist or a calendar can also remove what it
  brought in, not just the token. Nothing is ever deleted on the provider's side.
- **Remove data on uninstall** — the Windows uninstaller offers to delete your data (unticked
  by default, and never during an update).

---

## Planned

### v1.0 — hardening

Turns a working personal tool into one a stranger can rely on.

- **The background services** — Todoist sync, calendar fetching, the timer and the database —
  each get defined behaviour for being offline, rate-limited, revoked, sent malformed data or
  interrupted mid-write, and say so in the UI rather than showing stale data as current.
- **Data integrity** — the database is checked on open and never silently replaced by an
  empty one; backups can be browsed and restored from inside the app; every shipped schema
  version is migrated in tests.
- **Electron security review** — navigation and permission lockdown, a content security
  policy, runtime fuses, and every message from a window validated before it's acted on.
- Keyboard navigation throughout, a first-run onboarding pass, and a privacy statement covering
  exactly what the integrations read and where credentials live.

### v2.0 — off TypeScript

A move to Go or Rust, most likely the main process first (timer, storage and sync), with the
existing test suite as the specification the port has to pass. Which language is decided by a
small spike after v1.0 — porting the timer and database layer both ways and comparing — rather
than up front.

---

## Later, after v1.0

Postponed past v1.0 on 2026-09-25, to keep the near-term roadmap focused on hardening what
already exists rather than adding more integrations to harden later.

- **Google Calendar over OAuth** — for calendars that can't expose a secret iCal address, and
  as a sturdier alternative to it. Installed-app OAuth with PKCE and a loopback redirect,
  read-only scope, no client secret in the code — the repository is public.
- **Jira** — an additional task source alongside Todoist, read-only to begin with. Synced
  issues are marked as such and link back to Jira.

---

## The standard every release meets

- Typecheck, the full unit suite, a real build and an end-to-end run of the built app, on
  Windows and Linux, before anything merges. A dependency-free standards script and
  `npm audit` run alongside it, gating every merge and release the same way.
- A release publishes only from a commit that passed all of that, with written release notes.
- Credentials only ever in the operating system's secure storage, and never in an export.
- Your data is never deleted without you asking, and never touched by an update.

## Not planned

- **A mobile app.** Flowdo is a desktop tool that watches you work at a desk.
- **A sync service.** Your data stays on your machine. Export and import cover moving it.
- **Team features.** This is a personal tracker.

## Where your data lives

| Platform | Path |
|---|---|
| Windows | `%APPDATA%\Flowdo` |
| Linux | `~/.config/Flowdo` |

Uninstalling does not delete it.
