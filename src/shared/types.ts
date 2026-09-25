/**
 * FROZEN CONTRACT — imported by main, preload, and renderer.
 *
 * This file is the single definition of every shape that crosses a process boundary.
 * If main and renderer ever disagree about `TimerState`, the app lies to the user about
 * how long they focused, so this file changes deliberately and never opportunistically.
 *
 * Convention: TypeScript is camelCase, SQLite columns are snake_case. The repos in
 * src/main/db/repo/ own that mapping; nothing else should know about snake_case.
 * All instants are epoch milliseconds (`Date.now()`), never Date objects — they have to
 * survive structured-clone across IPC.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Timer
// ─────────────────────────────────────────────────────────────────────────────

export type TimerMode = 'pomodoro' | 'flowmodoro'

export type SessionKind = 'focus' | 'short_break' | 'long_break'

export type TimerStatus = 'idle' | 'running' | 'paused'

/**
 * The wall-clock anchors a session is derived from.
 *
 * Elapsed time is ALWAYS computed as a delta against these, never by accumulating
 * interval ticks. Chromium throttles timers in background windows and machines sleep;
 * only a wall-clock delta survives both.
 */
export interface TimerAnchor {
  /** Epoch ms when this phase started. */
  startedAt: number
  /** Epoch ms when the current pause began, or null if running. */
  pausedAt: number | null
  /** Total ms spent paused during this phase, excluding an in-progress pause. */
  pausedTotalMs: number
}

/**
 * Broadcast from main on every tick. The renderer renders this verbatim and must not
 * recompute elapsed/remaining from its own clock — that reintroduces the drift the
 * main-process timer exists to prevent.
 */
export interface TimerState extends TimerAnchor {
  mode: TimerMode
  status: TimerStatus
  /** null only when status is 'idle'. */
  kind: SessionKind | null

  /** Target duration for this phase. null = open-ended (Flowmodoro focus). */
  plannedMs: number | null

  // ── derived by main, read-only for consumers ──
  elapsedMs: number
  /** null when the phase is open-ended. */
  remainingMs: number | null
  /** Break earned so far. Non-null only during Flowmodoro focus. */
  earnedBreakMs: number | null
  /** 0..1 against plannedMs; always 0 for an open-ended phase. */
  progress: number

  /** Focus rounds finished in the current long-break cycle. Resets after a long break. */
  focusRoundsCompleted: number
  /** Echoed from settings so the UI can render "3/4" without a second IPC call. */
  longBreakEvery: number

  taskId: number | null
  projectId: number | null
  /** True when a sleep/suspend gap exceeded settings.sleepGraceMs during this phase. */
  interrupted: boolean
}

/** Emitted when a phase ends, after its session row has been written. */
export interface PhaseEndEvent {
  /** Row id in `sessions`, or null when the session was discarded rather than logged. */
  sessionId: number | null
  mode: TimerMode
  kind: SessionKind
  actualMs: number
  plannedMs: number | null
  /** Pomodoro: reached plannedMs. Flowmodoro focus: always true (the user chose to stop). */
  completed: boolean
  interrupted: boolean
  taskId: number | null
  /** What comes next, already computed. null when returning to idle. */
  nextKind: SessionKind | null
  nextPlannedMs: number | null
  /** Whether main auto-started `nextKind` per settings. */
  autoStarted: boolean
}

/** What to do with an in-flight session when the user flips the mode toggle. */
export type OnRunningSession = 'keep' | 'discard'

// ─────────────────────────────────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────────────────────────────────

export interface Settings {
  mode: TimerMode

  // Pomodoro
  pomodoroFocusMs: number
  pomodoroShortBreakMs: number
  pomodoroLongBreakMs: number
  /** A long break replaces the short one after every Nth focus round. */
  longBreakEvery: number

  // Flowmodoro
  /** break = focusElapsed / divisor. flowmo.io uses 5. */
  flowmodoroDivisor: number
  flowmodoroMinBreakMs: number
  flowmodoroMaxBreakMs: number

  autoStartBreaks: boolean
  autoStartFocus: boolean

  notificationsEnabled: boolean
  soundEnabled: boolean

  minimizeToTray: boolean
  launchAtLogin: boolean
  /** Pinned: the mini widget stays open whatever the main window is doing. */
  showMiniWidget: boolean
  /**
   * Show the mini widget on its own while the main window is off screen — minimized, or
   * closed to the tray — and put it away again when the window comes back. A widget the
   * user pinned with `showMiniWidget` is never put away by this.
   */
  miniWidgetOnMinimize: boolean
  theme: 'system' | 'light' | 'dark'

  hotkeyStartPause: string
  hotkeySkip: string

  /**
   * A suspend/resume gap longer than this marks the session `interrupted` and is
   * subtracted from its focus time. Sleeping for an hour is not an hour of focus.
   */
  sleepGraceMs: number

  /**
   * The first day of the calendar week, in `Date#getDay()` numbering (0 = Sunday). Governs
   * the Week and Month views and the Stats "This week" range, so "this week" means the same
   * seven days everywhere in the app.
   */
  weekStartsOn: Weekday

  /** Shell arrangement. See `LayoutSettings`. */
  layout: LayoutSettings
}

/** A day of the week in `Date#getDay()` numbering: 0 = Sunday … 6 = Saturday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** Every `Weekday`, Sunday first — the one list validators and pickers iterate. */
export const WEEKDAYS: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6]

// ─────────────────────────────────────────────────────────────────────────────
// Layout
// ─────────────────────────────────────────────────────────────────────────────

/** The three columns of the main shell, left to right by default. */
export type PanelId = 'projects' | 'timer' | 'main'

export const PANEL_IDS: readonly PanelId[] = ['projects', 'timer', 'main']

/**
 * User-arranged shell layout.
 *
 * Stored as a single settings key rather than one row per field. That is a deliberate,
 * bounded exception to the rule in db/repo/settings.ts: layout is written from exactly
 * one place and is a coherent unit, and being one key among many it still cannot clobber
 * an unrelated setting.
 */
export interface LayoutSettings {
  /** Left-to-right order. Always a permutation of PANEL_IDS. */
  order: PanelId[]
  /** Pixel widths. The last panel in `order` flexes and ignores its entry. */
  widths: Record<PanelId, number>
  /** Panels currently collapsed to a rail. Never contains the flexing panel. */
  collapsed: PanelId[]
}

/** Below this a panel is unusable, so a drag clamps here rather than to zero. */
export const PANEL_MIN_WIDTH: Record<PanelId, number> = {
  projects: 160,
  timer: 300,
  main: 280
}

export const PANEL_MAX_WIDTH: Record<PanelId, number> = {
  projects: 420,
  timer: 560,
  main: 900
}

/** Matches the widths v0.1 hard-coded in App.tsx, so upgrading changes nothing visually. */
export const DEFAULT_LAYOUT: LayoutSettings = {
  order: ['projects', 'timer', 'main'],
  widths: { projects: 208, timer: 368, main: 480 },
  collapsed: []
}

export const DEFAULT_SETTINGS: Settings = {
  mode: 'flowmodoro',

  pomodoroFocusMs: 25 * 60_000,
  pomodoroShortBreakMs: 5 * 60_000,
  pomodoroLongBreakMs: 15 * 60_000,
  longBreakEvery: 4,

  flowmodoroDivisor: 5,
  flowmodoroMinBreakMs: 60_000,
  flowmodoroMaxBreakMs: 30 * 60_000,

  autoStartBreaks: true,
  autoStartFocus: false,

  notificationsEnabled: true,
  soundEnabled: true,

  minimizeToTray: true,
  launchAtLogin: false,
  showMiniWidget: false,
  miniWidgetOnMinimize: true,
  theme: 'system',

  // Control+Alt+Space is the obvious choice and was the original default, but it is
  // already claimed on Windows (IME / Office bindings) — verified by probing
  // globalShortcut.register(), which returns false rather than throwing. A default that
  // silently never fires is worse than an unfamiliar one, so P/S it is.
  hotkeyStartPause: 'Control+Alt+P',
  hotkeySkip: 'Control+Alt+S',

  sleepGraceMs: 2 * 60_000,

  // Monday, as every version before 0.3.1 hard-coded.
  weekStartsOn: 1,

  layout: DEFAULT_LAYOUT
}

// ─────────────────────────────────────────────────────────────────────────────
// Entities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where a row came from. `null` means it was created in Flowdo.
 *
 * A synced row's `externalId` is the provider's id, always a string: Todoist ids are
 * strings, and treating them as numbers would silently break the day one exceeds 2^53.
 */
export type SyncSource = 'todoist'

export interface SyncOrigin {
  source: SyncSource | null
  externalId: string | null
}

/**
 * Synced projects are pull-only: Flowdo mirrors them but never renames, archives or deletes
 * them upstream, so the UI must not offer those actions on a synced project.
 */
export interface Project extends SyncOrigin {
  id: number
  name: string
  /** Hex, e.g. '#6366f1'. Drives the stats breakdown colours. */
  color: string
  archived: boolean
  sortOrder: number
  createdAt: number
}

export interface ProjectCreate {
  name: string
  color?: string
}

export type ProjectUpdate = Partial<Omit<Project, 'id' | 'createdAt' | keyof SyncOrigin>>

/** 1 = highest. Mirrors Focus To-Do's four levels. */
export type Priority = 1 | 2 | 3 | 4

/**
 * A synced task is edited here and pushed upstream (two-way). Its identity fields are owned
 * by the sync engine and are never accepted from the renderer — see `TaskUpdate`.
 */
export interface Task extends SyncOrigin {
  id: number
  projectId: number
  title: string
  notes: string | null
  priority: Priority
  /** Local calendar day as 'YYYY-MM-DD'. Deliberately not an instant — a due date
   *  has no time zone, and storing it as epoch ms shifts the day across DST. */
  dueDate: string | null
  /**
   * Local wall-clock time of day, 'HH:MM', when the due date has one (a Todoist task "due
   * 21 Nov 19:00"); null for date-only and local tasks. Display and ordering only — it is
   * NOT an instant and is never combined with dueDate into one, for the same reason
   * dueDate is not an instant. Derived from the provider's due object; not editable.
   */
  dueTime: string | null
  /**
   * IANA zone the due time is defined in (Todoist's due.timezone), e.g. 'Asia/Tehran'.
   * Null for date-only, floating (zone-less) and local tasks. With `dueTimeLocal` it lets
   * the UI show both "07:15 Tehran" and "07:45 local" when the two clocks disagree.
   */
  dueZone: string | null
  /**
   * The same moment as `dueTime`/`dueZone`, on THIS computer's clock, 'HH:MM'. Equal to
   * `dueTime` when the zones agree; null whenever `dueZone` is null. Display only.
   */
  dueTimeLocal: string | null
  estimatedPomodoros: number | null
  sortOrder: number
  completedAt: number | null
  createdAt: number
  /**
   * Recurs upstream. Completing it advances its due date on the provider and it comes back
   * open — so the UI must not present "complete" as closing it for good.
   */
  recurring: boolean
  /** Deleted upstream; kept here until the user decides. Null for local tasks. */
  remoteDeletedAt: number | null
}

export interface TaskCreate {
  projectId: number
  title: string
  notes?: string | null
  priority?: Priority
  dueDate?: string | null
  estimatedPomodoros?: number | null
}

export type TaskUpdate = Partial<
  Omit<Task, 'id' | 'createdAt' | 'recurring' | 'remoteDeletedAt' | 'dueTime' | 'dueZone' | 'dueTimeLocal' | keyof SyncOrigin>
>

/** Task joined with counts derived from `sessions` and `subtasks`. Never stored. */
export interface TaskWithStats extends Task {
  /** COUNT of completed focus sessions attached to this task. */
  actualPomodoros: number
  focusMs: number
  subtaskTotal: number
  subtaskDone: number
}

export interface Subtask extends SyncOrigin {
  id: number
  taskId: number
  title: string
  done: boolean
  sortOrder: number
}

export interface SubtaskCreate {
  taskId: number
  title: string
}

export type SubtaskUpdate = Partial<Omit<Subtask, 'id' | 'taskId' | keyof SyncOrigin>>

/**
 * Append-only log. The single source of every statistic in the app — there are no
 * denormalised counters anywhere, precisely so nothing can drift out of agreement
 * with this table.
 */
export interface Session {
  id: number
  taskId: number | null
  projectId: number | null
  mode: TimerMode
  kind: SessionKind
  startedAt: number
  endedAt: number
  /** null for Flowmodoro focus, which has no plan by definition. */
  plannedMs: number | null
  actualMs: number
  completed: boolean
  interrupted: boolean
  notes: string | null
}

export type SessionCreate = Omit<Session, 'id'>

// ─────────────────────────────────────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────────────────────────────────────

export type StatsRange = 'today' | 'week' | 'year' | 'all'

export interface ModeSplit {
  focusMs: number
  sessions: number
}

export interface StatsSummary {
  range: StatsRange
  focusMs: number
  focusSessions: number
  breakMs: number
  completedTasks: number
  /** Mean completed focus session length — the number that shows whether
   *  Flowmodoro is actually buying you longer stretches than Pomodoro. */
  avgFocusMs: number
  byMode: Record<TimerMode, ModeSplit>
  /** Consecutive days ending today with at least one completed focus session. */
  streakDays: number
}

export interface DailyBucket {
  /** 'YYYY-MM-DD', local time. */
  date: string
  focusMs: number
  sessions: number
}

export interface ProjectBucket {
  projectId: number
  projectName: string
  color: string
  focusMs: number
  sessions: number
}

// ─────────────────────────────────────────────────────────────────────────────
// System / hotkeys
// ─────────────────────────────────────────────────────────────────────────────

export type HotkeyAction = 'startPause' | 'skip'

/**
 * Why a global shortcut is not active. Lives here rather than in main/hotkeys.ts
 * because it crosses the process boundary to the settings UI.
 */
export interface HotkeyFailure {
  action: HotkeyAction
  accelerator: string
  /**
   * `taken`   — another running application owns the combination.
   * `invalid` — Electron rejected the accelerator string.
   * `unavailable` — the platform exposes no global-shortcut mechanism at all.
   *   This is the Wayland case: no combination will work, so the UI must say so
   *   rather than inviting the user to try a different one.
   */
  reason: 'taken' | 'invalid' | 'unavailable'
}

/** Result of a non-destructive probe, used while the user is choosing a combination. */
export type HotkeyProbe = 'free' | 'taken' | 'invalid' | 'unavailable'

// ─────────────────────────────────────────────────────────────────────────────
// Import / export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The on-disk export payload.
 *
 * `version` is mandatory and present from the first file ever written: once exports
 * exist in the wild, a format with no version is guesswork to parse. It is also what
 * will make it safe to start EXCLUDING data (integration tokens) in a later version.
 */
export interface ExportFile {
  version: 1
  exportedAt: number
  projects: Project[]
  tasks: Task[]
  subtasks: Subtask[]
  sessions: Session[]
  settings: Partial<Settings>
}

/** `path: null` means the user cancelled the dialog — a normal outcome, not an error. */
export interface ExportResult {
  path: string | null
  sessions: number
}

export interface ImportResult {
  path: string | null
  sessions: number
  /** Where the pre-import backup of the database was written. */
  backupPath: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Integrations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The state of one integration, as the renderer is allowed to see it.
 *
 * No variant carries a secret. The renderer can hand a token or feed URL to main once, and
 * afterwards can only ever learn whether it works.
 */
export type IntegrationHealth =
  | { state: 'disconnected' }
  /**
   * OS secure storage is not usable (Linux without an unlocked keyring falls back to a
   * plaintext backend). Flowdo refuses to store secrets rather than store them in the clear,
   * so the UI must explain how to fix the keyring, not invite the user to retry.
   */
  | { state: 'unavailable'; reason: 'no-secure-storage' }
  | { state: 'syncing'; lastOkAt: number | null }
  | { state: 'ok'; lastOkAt: number }
  /**
   * `auth`: the token was rejected — reconnecting is the only fix, and retrying is pointless.
   * `network`: offline or unreachable; retried automatically with backoff.
   * `rate-limit`: the provider asked us to slow down; retried after its delay.
   * `provider`: anything else the provider returned. Shown with its message.
   */
  | {
      state: 'error'
      kind: 'auth' | 'network' | 'rate-limit' | 'provider'
      message: string
      lastOkAt: number | null
      at: number
    }

export interface TodoistStatus {
  health: IntegrationHealth
  /** Local edits not yet accepted upstream. Non-zero while offline is normal, not an error. */
  pendingChanges: number
  /**
   * Local edits upstream refused permanently (e.g. the task no longer exists there). Each is
   * shown once and then dropped — retrying a 4xx forever would wedge the queue behind it.
   */
  rejectedChanges: { at: number; message: string }[]
}

export interface CalendarFeed {
  id: number
  name: string
  /** Hex, e.g. '#22c55e'. Chosen by the user; data, not theme. */
  color: string
  enabled: boolean
  /** Last successful refresh. Events shown are "as of" this, never presented as live. */
  lastOkAt: number | null
  /** Last failure message, cleared by the next success. The previous cache is kept. */
  lastError: string | null
}

export interface CalendarFeedCreate {
  name: string
  /** The secret iCal address. Sent to main once and never returned by any channel. */
  url: string
  color?: string
}

export type CalendarFeedUpdate = Partial<Pick<CalendarFeed, 'name' | 'color' | 'enabled'>>

/**
 * One occurrence of a calendar event, recurrence already expanded by main.
 *
 * Exactly one of two shapes, discriminated by `allDay`: a timed event is a pair of instants;
 * an all-day event is a pair of local calendar days with NO instants, exactly like
 * `Task.dueDate`. Converting an all-day event to midnight-UTC instants would move it to the
 * wrong day for anyone west of Greenwich.
 */
export type CalendarEvent = {
  id: number
  feedId: number
  title: string
  location: string | null
} & (
  /**
   * `timeZone`: the IANA zone the event was defined in (its TZID), or null for UTC/floating.
   * Blocks are positioned by the instants on this computer's clock; the zone is only used to
   * also label the event's original time when it differs from local.
   */
  | { allDay: false; startMs: number; endMs: number; timeZone: string | null }
  /** `endDate` is exclusive, as in RFC 5545: a one-day event on the 3rd ends on the 4th. */
  | { allDay: true; startDate: string; endDate: string }
)

/**
 * Pushed after anything outside the renderer changed stored data — a sync pull, a calendar
 * refresh — so the stores re-read instead of showing what was true before the sync.
 */
export type DataChangedScope = 'tasks' | 'projects' | 'calendar'

/**
 * How far around today calendar occurrences are expanded and cached, in local days.
 * Past covers a full month grid (up to six weeks shown) looking back; future covers about
 * four months ahead. Shared so the calendar views can say "events are shown up to …" when
 * navigated past it, instead of drawing an empty grid that looks like a free month.
 */
export const CALENDAR_CACHE_DAYS = { past: 42, future: 120 } as const

/**
 * Short, readable name for an IANA zone in a time label: 'Asia/Tehran' → 'Tehran',
 * 'America/Argentina/Buenos_Aires' → 'Buenos Aires'. Falls back to the input.
 */
export function zoneLabel(timeZone: string): string {
  const last = timeZone.split('/').pop() ?? timeZone
  return last.replace(/_/g, ' ')
}

/** Where a synced task lives upstream, for "open in Todoist". */
export function todoistTaskUrl(externalId: string): string {
  return `https://app.todoist.com/app/task/${encodeURIComponent(externalId)}`
}

// ─────────────────────────────────────────────────────────────────────────────
// The preload bridge
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The complete renderer↔main surface. Every method is a named, typed IPC channel;
 * there is deliberately no generic `query(sql)` escape hatch, so a compromised
 * renderer cannot reach arbitrary SQL.
 *
 * `on*` subscribers return an unsubscribe function — call it in a React cleanup or
 * listeners accumulate on every hot reload.
 */
export interface FlowdoApi {
  timer: {
    getState(): Promise<TimerState>
    /**
     * Starts focus if idle (or the armed phase, if one is waiting); resumes if paused.
     *
     * `taskId` omitted keeps the current task; an explicit `null` CLEARS it. These are not
     * interchangeable — treating an omitted argument as null detaches the task and logs
     * the session against nothing.
     */
    start(taskId?: number | null): Promise<TimerState>
    pause(): Promise<TimerState>
    resume(): Promise<TimerState>
    /** Flowmodoro: end focus and begin the break it earned. */
    takeBreak(): Promise<TimerState>
    /** End the current phase and advance to the next one. */
    skip(): Promise<TimerState>
    /** Return to idle. `discard` drops the session instead of logging it. */
    stop(discard?: boolean): Promise<TimerState>
    setMode(mode: TimerMode, onRunning?: OnRunningSession): Promise<TimerState>
    setTask(taskId: number | null): Promise<TimerState>
    onTick(cb: (state: TimerState) => void): () => void
    onPhaseEnd(cb: (event: PhaseEndEvent) => void): () => void
  }

  projects: {
    list(includeArchived?: boolean): Promise<Project[]>
    create(input: ProjectCreate): Promise<Project>
    update(id: number, patch: ProjectUpdate): Promise<Project>
    remove(id: number): Promise<void>
  }

  tasks: {
    /** Open tasks for a project, or all projects when projectId is omitted. */
    list(projectId?: number | null): Promise<TaskWithStats[]>
    listCompleted(projectId?: number | null, limit?: number): Promise<TaskWithStats[]>
    get(id: number): Promise<TaskWithStats | null>
    create(input: TaskCreate): Promise<TaskWithStats>
    update(id: number, patch: TaskUpdate): Promise<TaskWithStats>
    setCompleted(id: number, completed: boolean): Promise<TaskWithStats>
    /** Persist an explicit order; ids in their new order. */
    reorder(ids: number[]): Promise<void>
    /**
     * Delete a task. For a synced task this ALSO deletes it upstream (queued for the next
     * sync), unless it was already deleted there — the UI must say which before confirming.
     */
    remove(id: number): Promise<void>
    /**
     * Turn a synced task (and its subtasks) into local ones: the link upstream is dropped and
     * nothing is pushed. This is the "keep it" answer for a task deleted upstream, and the
     * only way sync-owned fields change from the renderer.
     */
    keepLocal(id: number): Promise<TaskWithStats>
  }

  subtasks: {
    list(taskId: number): Promise<Subtask[]>
    create(input: SubtaskCreate): Promise<Subtask>
    update(id: number, patch: SubtaskUpdate): Promise<Subtask>
    remove(id: number): Promise<void>
  }

  sessions: {
    listRange(fromMs: number, toMs: number): Promise<Session[]>
    recent(limit?: number): Promise<Session[]>
    /** Delete one logged session. Every statistic above it drops accordingly. */
    remove(id: number): Promise<void>
  }

  stats: {
    summary(range: StatsRange): Promise<StatsSummary>
    daily(range: StatsRange): Promise<DailyBucket[]>
    byProject(range: StatsRange): Promise<ProjectBucket[]>
  }

  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
    onChange(cb: (settings: Settings) => void): () => void
  }

  data: {
    /** Whole database out through a save dialog, as an `ExportFile`. */
    exportJson(): Promise<ExportResult>
    /**
     * Replace the database from an export file, NOT merge it.
     *
     * Merging invites duplicate sessions with no stable identity to deduplicate on.
     * Main writes a timestamped backup first and returns where it went, so the UI can
     * state plainly that the current history is being replaced.
     */
    importJson(): Promise<ImportResult>
  }

  system: {
    /** Pushed whenever a registration pass produces failures. */
    onHotkeyFailures(cb: (failures: HotkeyFailure[]) => void): () => void
    getHotkeyFailures(): Promise<HotkeyFailure[]>
    /**
     * Register, check, and immediately unregister an accelerator.
     *
     * This is what makes the rebinding UI honest: the user learns a combination is
     * taken WHILE CHOOSING IT, rather than silently discovering later that it never
     * fires. Must leave the real registrations untouched.
     */
    probeHotkey(accelerator: string): Promise<HotkeyProbe>
    /**
     * Temporarily unregister (true) or restore (false) the app's own global shortcuts.
     *
     * While the settings screen records a new combination, the live shortcuts would
     * otherwise fire — pressing the skip combination while rebinding start/pause would skip
     * the timer instead of being captured. Restored automatically if the window closes or
     * reloads, so a crashed settings screen cannot leave the hotkeys dead.
     */
    suspendHotkeys(suspended: boolean): Promise<void>
  }

  integrations: {
    todoist: {
      status(): Promise<TodoistStatus>
      /**
       * Validate the token against the API, then store it encrypted and start syncing.
       * Resolves to the resulting status; an invalid token is an `error`/`auth` status,
       * and nothing is stored.
       */
      connect(token: string): Promise<TodoistStatus>
      /**
       * Forget the token and stop syncing. Synced tasks stay, converted to local tasks —
       * the sessions logged against them are history, and disconnecting must not erase it.
       * Pending changes are discarded, and the UI must say so before calling this.
       */
      disconnect(): Promise<void>
      syncNow(): Promise<TodoistStatus>
      onStatus(cb: (status: TodoistStatus) => void): () => void
    }
    calendars: {
      list(): Promise<CalendarFeed[]>
      /** Fetches and parses the feed before saving it, so a wrong URL fails here, visibly. */
      add(feed: CalendarFeedCreate): Promise<CalendarFeed>
      update(id: number, patch: CalendarFeedUpdate): Promise<CalendarFeed>
      /** Deletes the feed, its cached events, and its stored URL. */
      remove(id: number): Promise<void>
      refreshNow(): Promise<CalendarFeed[]>
      /** Whether secrets can be stored at all; if not, adding a feed will be refused. */
      secureStorageAvailable(): Promise<boolean>
    }
  }

  calendar: {
    /** Occurrences overlapping [fromMs, toMs), from enabled feeds, timed and all-day alike.
     *  All-day events are included when their local day range overlaps the local days
     *  the range covers. */
    eventsRange(fromMs: number, toMs: number): Promise<CalendarEvent[]>
  }

  events: {
    onDataChanged(cb: (scope: DataChangedScope) => void): () => void
  }

  app: {
    getVersion(): Promise<string>
    setMiniWidget(visible: boolean): Promise<void>
    /** True when this window is the mini widget rather than the main window. */
    isMiniWindow(): Promise<boolean>
    quit(): Promise<void>
  }
}
