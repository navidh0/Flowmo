#!/bin/sh
# Starts Xvfb plus a window manager (openbox) and runs the given command under it.
#
# Minimize needs a window manager, which real Windows/Linux desktops always have and a bare
# Xvfb display does not — without one, `win.minimize()` is a no-op and the mini-widget's
# minimize checks (e2e/suites/mini.mjs) would silently never trigger. This is what both a
# local run and CI use to get a WM under Xvfb; see e2e/smoke.mjs / e2e/run.mjs's
# `--no-minimize` for the fallback when no WM is available at all.
#
# Usage: e2e/xvfb-wm.sh <command> [args...]
set -e
exec xvfb-run -a -s "-screen 0 1500x950x24" sh -c 'openbox & sleep 1; exec "$@"' _ "$@"
