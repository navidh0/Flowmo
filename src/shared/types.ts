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
  showMiniWidget: boolean
  theme: 'system' | 'light' | 'dark'

  hotkeyStartPause: string
  hotkeySkip: string

  /**
   * A suspend/resume gap longer than this marks the session `interrupted` and is
   * subtracted from its focus time. Sleeping for an hour is not an hour of focus.
   */
  sleepGraceMs: number
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
  theme: 'system',

  // Control+Alt+Space is the obvious choice and was the original default, but it is
  // already claimed on Windows (IME / Office bindings) — verified by probing
  // globalShortcut.register(), which returns false rather than throwing. A default that
  // silently never fires is worse than an unfamiliar one, so P/S it is.
  hotkeyStartPause: 'Control+Alt+P',
  hotkeySkip: 'Control+Alt+S',

  sleepGraceMs: 2 * 60_000
}

// ─────────────────────────────────────────────────────────────────────────────
// Entities
// ─────────────────────────────────────────────────────────────────────────────

export interface Project {
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

export type ProjectUpdate = Partial<Omit<Project, 'id' | 'createdAt'>>

/** 1 = highest. Mirrors Focus To-Do's four levels. */
export type Priority = 1 | 2 | 3 | 4

export interface Task {
  id: number
  projectId: number
  title: string
  notes: string | null
  priority: Priority
  /** Local calendar day as 'YYYY-MM-DD'. Deliberately not an instant — a due date
   *  has no time zone, and storing it as epoch ms shifts the day across DST. */
  dueDate: string | null
  estimatedPomodoros: number | null
  sortOrder: number
  completedAt: number | null
  createdAt: number
}

export interface TaskCreate {
  projectId: number
  title: string
  notes?: string | null
  priority?: Priority
  dueDate?: string | null
  estimatedPomodoros?: number | null
}

export type TaskUpdate = Partial<Omit<Task, 'id' | 'createdAt'>>

/** Task joined with counts derived from `sessions` and `subtasks`. Never stored. */
export interface TaskWithStats extends Task {
  /** COUNT of completed focus sessions attached to this task. */
  actualPomodoros: number
  focusMs: number
  subtaskTotal: number
  subtaskDone: number
}

export interface Subtask {
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

export type SubtaskUpdate = Partial<Omit<Subtask, 'id' | 'taskId'>>

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
    remove(id: number): Promise<void>
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

  app: {
    getVersion(): Promise<string>
    setMiniWidget(visible: boolean): Promise<void>
    /** True when this window is the mini widget rather than the main window. */
    isMiniWindow(): Promise<boolean>
    quit(): Promise<void>
  }
}
