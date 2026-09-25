/**
 * Launch-at-login for Linux.
 *
 * `app.setLoginItemSettings` (the Electron API Windows/macOS use for this) is a no-op on
 * Linux — there is no OS-level "run at login" registry to hook into. The XDG Autostart
 * spec instead has every desktop environment (GNOME, KDE, Xfce, …) scan
 * `$XDG_CONFIG_HOME/autostart/*.desktop` (default `~/.config/autostart`) at login and
 * launch anything listed there. So "autostart" on Linux just means: write (or remove) one
 * `.desktop` file.
 *
 * This module takes no dependency on `electron` — every external input (home directory,
 * XDG_CONFIG_HOME, the running executable's path, an optional AppImage path) is passed in
 * by the caller — so it can be unit tested with plain temp directories and no Electron
 * runtime. The intended caller (src/main/index.ts, out of scope here) is expected to call
 * this instead of `app.setLoginItemSettings` when `process.platform === 'linux'`.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface AutostartDeps {
  /** The user's home directory, e.g. `os.homedir()`. */
  homeDir: string
  /** `process.env.XDG_CONFIG_HOME`, when set — honoured per the XDG Base Directory spec. */
  xdgConfigHome?: string
  /** `process.execPath` — the running Electron/Node binary. Used when not an AppImage. */
  execPath: string
  /**
   * `process.env.APPIMAGE`, when the app is running as a packaged AppImage. Electron
   * itself sets `process.execPath` to a path *inside* the mounted/extracted AppImage in
   * that case, which won't exist next time the AppImage is (re)mounted at a new temp
   * mountpoint — so the AppImage's own stable path must be preferred whenever present.
   */
  appImagePath?: string
}

const DESKTOP_FILE_NAME = 'flowdo.desktop'

/** Characters that force an Exec argument to be quoted, per the Desktop Entry Spec. */
const RESERVED_CHARS = /[ \t\n"'\\><~|&;$*?#()`]/

/**
 * Quotes a single Exec argument per the freedesktop Desktop Entry Spec's "Exec key"
 * rules: https://specifications.freedesktop.org/desktop-entry-spec/latest/exec-variables.html
 *
 * An argument that contains no reserved character is left bare. Otherwise it is wrapped
 * in double quotes, and — *inside* those quotes — the spec requires escaping exactly four
 * characters by prefixing them with an extra backslash: `"`, `` ` ``, `$`, and `\` itself.
 * (Notably a single quote does *not* need escaping inside double quotes.)
 */
export function quoteExecArg(arg: string): string {
  if (!RESERVED_CHARS.test(arg)) return arg
  const escaped = arg.replace(/([\\"$`])/g, '\\$1')
  return `"${escaped}"`
}

/** Builds the `.desktop` file contents for autostarting Flowdo, given the exec target. */
export function desktopEntry(execTarget: string): string {
  const exec = quoteExecArg(execTarget)
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Flowdo',
    `Exec=${exec}`,
    'Comment=Start Flowdo automatically at login',
    'X-GNOME-Autostart-enabled=true',
    'Terminal=false',
    ''
  ].join('\n')
}

function autostartDir(deps: AutostartDeps): string {
  const configHome =
    deps.xdgConfigHome && deps.xdgConfigHome.length > 0
      ? deps.xdgConfigHome
      : join(deps.homeDir, '.config')
  return join(configHome, 'autostart')
}

function autostartFilePath(deps: AutostartDeps): string {
  return join(autostartDir(deps), DESKTOP_FILE_NAME)
}

/** The path to launch: the AppImage's own path when running as one, else the executable. */
function execTargetFor(deps: AutostartDeps): string {
  return deps.appImagePath && deps.appImagePath.length > 0 ? deps.appImagePath : deps.execPath
}

/**
 * Writes or removes `~/.config/autostart/flowdo.desktop` (honouring `XDG_CONFIG_HOME`).
 *
 * Idempotent: enabling twice overwrites with the same content, disabling twice (or
 * disabling when never enabled) is a no-op. Never throws — a read-only or missing home
 * directory is logged as a warning and otherwise ignored, since a failure here must not
 * crash app startup.
 */
export function setLinuxAutostart(enabled: boolean, deps: AutostartDeps): void {
  const filePath = autostartFilePath(deps)
  try {
    if (enabled) {
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, desktopEntry(execTargetFor(deps)), 'utf-8')
    } else if (existsSync(filePath)) {
      rmSync(filePath, { force: true })
    }
  } catch (error) {
    console.warn(
      `[autostart] failed to ${enabled ? 'enable' : 'disable'} launch at login: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

/** Whether the autostart `.desktop` file currently exists. Never throws. */
export function isLinuxAutostartEnabled(deps: AutostartDeps): boolean {
  try {
    return existsSync(autostartFilePath(deps))
  } catch (error) {
    console.warn(
      `[autostart] failed to check launch-at-login state: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return false
  }
}
