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

---

## Planned

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

### v0.3 — Linux, and a real release pipeline

- AppImage and `.deb` builds alongside the Windows installer.
- Automatic updates via GitHub Releases, with a manual check in Settings.
- Continuous integration building and testing both platforms on every tagged release.
- Graceful degradation where a platform genuinely cannot do something. Global hotkeys are
  unavailable under Wayland, for instance; the app says so rather than appearing to accept a
  binding that will never fire.

### v0.4 — making it yours

- **Session timeline** — a day and week view of what you actually worked on and when.
- **Light theme** — following the OS by default, overridable in Settings.
- **Real notification sounds**, replacing the current system beep.
- **Layout, continued** — reorder the panels, a compact density mode, and a resizable mini widget.

### v0.5 — calendars

See the day you actually have before deciding what to focus on. Calendar events render alongside
the session timeline from v0.4.

- Google Calendar first, read-only, then CalDAV and plain `.ics` subscriptions.
- Credentials are stored through the operating system's secure storage — DPAPI on Windows, the
  system keyring on Linux. Where no secure backend is available, Flowdo declines to store the
  token and says why rather than falling back to plain text.
- Tokens never leave the main process, are never included in an export, and no client secret is
  embedded in the source.

### v0.6 — task sources

Pull real work items in rather than retyping them: Todoist first, then Jira. Read-only to begin
with. Deleting or unsyncing a task never erases the time already recorded against it.

### v1.0 — polish

Keyboard navigation throughout, proper error and offline states for every integration, a first-run
onboarding pass, a data-integrity review covering backup and restore, and a privacy statement
covering exactly what the integrations read and where credentials live.

---

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
