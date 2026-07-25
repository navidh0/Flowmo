/**
 * FROZEN CONTRACT — the only IPC channel names in the app.
 *
 * Main registers handlers for these, preload invokes them. Both import from here so a
 * typo can't produce a silently dead channel that only fails at runtime.
 */

export const CH = {
  timer: {
    getState: 'timer:getState',
    start: 'timer:start',
    pause: 'timer:pause',
    resume: 'timer:resume',
    takeBreak: 'timer:takeBreak',
    skip: 'timer:skip',
    stop: 'timer:stop',
    setMode: 'timer:setMode',
    setTask: 'timer:setTask'
  },
  projects: {
    list: 'projects:list',
    create: 'projects:create',
    update: 'projects:update',
    remove: 'projects:remove'
  },
  tasks: {
    list: 'tasks:list',
    listCompleted: 'tasks:listCompleted',
    get: 'tasks:get',
    create: 'tasks:create',
    update: 'tasks:update',
    setCompleted: 'tasks:setCompleted',
    reorder: 'tasks:reorder',
    remove: 'tasks:remove'
  },
  subtasks: {
    list: 'subtasks:list',
    create: 'subtasks:create',
    update: 'subtasks:update',
    remove: 'subtasks:remove'
  },
  sessions: {
    listRange: 'sessions:listRange',
    recent: 'sessions:recent'
  },
  stats: {
    summary: 'stats:summary',
    daily: 'stats:daily',
    byProject: 'stats:byProject'
  },
  settings: {
    get: 'settings:get',
    set: 'settings:set'
  },
  app: {
    getVersion: 'app:getVersion',
    setMiniWidget: 'app:setMiniWidget',
    isMiniWindow: 'app:isMiniWindow',
    quit: 'app:quit'
  }
} as const

/** Main → renderer pushes. Broadcast to every open window. */
export const EV = {
  timerTick: 'ev:timer:tick',
  timerPhaseEnd: 'ev:timer:phaseEnd',
  settingsChanged: 'ev:settings:changed'
} as const
