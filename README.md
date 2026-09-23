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
  drag-to-reorder.
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

See `docs/ROADMAP.md` for the full plan. Next up after the current release:
Todoist and Google Calendar integrations.
