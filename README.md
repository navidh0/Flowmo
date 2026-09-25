# Flowdo

Flowdo is a desktop time tracker for Windows that combines Pomodoro and Flowmodoro
timing with a task and project list, so the history of what you worked on and the
history of how long you focused live in the same place. The timer runs in the main
process against wall-clock timestamps rather than accumulated ticks, so it stays
correct across background throttling, minimized windows, and machine sleep.

## Timer modes

Flowdo has two interval styles, switchable without losing a running session.

**Pomodoro** runs fixed-length blocks. By default: 25-minute focus, 5-minute short
break, 15-minute long break, with a long break every 4th focus round. All four
values are editable in Settings.

**Flowmodoro** is open-ended: you focus for as long as you want, then stop, and the
break is calculated from what you actually did — `break = focus time / divisor`,
clamped between a minimum and maximum. Defaults: divisor 5, minimum break 1 minute,
maximum break 30 minutes. So 25 minutes of focus earns a 5-minute break, and 4 hours
of focus still only earns the 30-minute cap.

Both modes log every session (including ones you stop early) to the same history,
which is why total focus time and completed-pomodoro counts are reported separately
and are allowed to disagree — stopping a session at the 20-minute mark is still 20
minutes spent, even though it didn't complete a round.

## Features

- Projects, tasks and subtasks, with priorities, due dates, estimates, and
  drag-to-reorder. The task list opens on **Today** — overdue first, then
  by time — with **Upcoming** covering the next seven days.
- A Calendar screen with Day, Week and Month views: the sessions you
  actually worked alongside your calendar events. When a task or event was
  set in a different time zone than your computer's, both times are shown
  (for example "07:15 Tehran · 07:45 local"). The week starts on whichever
  day you choose in Settings, Monday by default.
- A stats page: today / week / year / all-time ranges, a daily chart, a
  per-project breakdown, a Pomodoro-vs-Flowmodoro split, and a streak.
- Session history with per-session delete.
- A settings screen covering every duration and toggle, including hotkey
  rebinding: capturing a combination checks it live against what's already
  registered on your system and tells you immediately if it's taken, rather than
  saving a binding that silently never fires.
- An always-on-top mini widget, a tray icon reflecting live state, and taskbar
  progress.
- Global hotkeys for start/pause and skip.
- JSON export and import. Import **replaces** the entire database — it is not a
  merge — and Flowdo writes a timestamped backup of the existing database before
  touching anything, so a bad import can be undone by restoring that backup file.

## Integrations

### Todoist

Connect a Todoist account to sync tasks and subtasks two-way, using your personal
API token. Find it in Todoist under **Settings → Integrations → Developer → API
token**.

Projects come from Todoist and are read-only in Flowdo — rename or delete them in
Todoist itself. Completing a recurring task advances it to its next occurrence,
the same as it would in Todoist. If a task is deleted on the Todoist side, Flowdo
marks it rather than removing it, and you choose whether to keep it as a local
task or delete it.

Sync runs every few minutes and again whenever you bring the window back into
focus. Changes you make while offline are queued and sent once you're back
online.

Disconnecting turns your synced tasks into ordinary local tasks — it never
deletes them, and it never deletes the time already logged against them.

### Google Calendar

Add a calendar's **Secret address in iCal format** (in Google Calendar: the
calendar's ⋮ menu → Settings and sharing → "Secret address in iCal format") to
show its events on the Calendar screen. This is read-only — Flowdo never writes back
to your calendar.

Events are cached roughly six weeks back and four months ahead of today, and the
feed can lag slightly behind what's on Google's side.

### Security

Your Todoist token and calendar addresses are stored encrypted, using the
operating system's secure storage, and never leave the main process. If secure
storage isn't available on your machine, Flowdo refuses to store them rather than
fall back to storing them unencrypted. Exported data never includes them, and
nothing is sent anywhere except to Todoist and the calendar addresses you
add.

Note: JSON import is refused while Todoist is connected, since the imported data
could conflict with what's actively syncing — disconnect first if you need to
import.

## Install

Download the installer from the project's GitHub Releases page and run it.

The installer is unsigned, so Windows SmartScreen will show a blue "Windows
protected your PC" warning when you run it. This is expected for an app without a
paid code-signing certificate, not a sign of tampering. To proceed, click
**More info**, then **Run anyway**.

A portable (no-install) build is also published alongside the installer.

Uninstalling does not delete your data — see below.

## Build from source

Requires Node.js 22.5 or newer (Flowdo uses Node's built-in `node:sqlite`, which
needs a recent Node) and npm.

```
npm install
npm run dev         # run in development
npm run test        # run the test suite once
npm run typecheck   # typecheck both the main and renderer projects
npm run dist        # package a Windows installer into release/
```

There's no native module to rebuild against Electron's ABI — SQLite access goes
through `node:sqlite`, which ships inside Electron itself, so `npm run dist`
doesn't need a C++ toolchain.

## Where your data lives

Flowdo stores everything in `%APPDATA%\Flowdo`, in a SQLite database file named
`flowdo.db`. Uninstalling the app leaves this directory in place.

Running an import writes a timestamped backup of `flowdo.db` into the same
directory (`flowdo-backup-<date>_<time>.db`) before replacing the data, so the
pre-import state is always recoverable.

## Roadmap

See `docs/ROADMAP.md` for the full plan. In progress: Todoist and Google
Calendar integrations, and a day timeline.
