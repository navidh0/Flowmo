/**
 * Projects, tasks, and subtasks for the renderer.
 *
 * Every mutation goes out over `window.flowdo` and then re-reads the slice it touched
 * instead of patching local state from the returned row. `TaskWithStats` carries counts
 * the main process derives from `sessions` and `subtasks` (`actualPomodoros`, `focusMs`,
 * `subtaskDone`), and a local patch would quietly get those wrong — the whole point of
 * deriving them server-side is that nothing else is allowed to guess. SQLite is
 * in-process, so a re-read is cheaper than a stale count.
 *
 * `tasks.update` / `setCompleted` / `projects.update` THROW when the id is gone, which is
 * a real case: a second click on a row a background refresh has already dropped. Every
 * action funnels through `attempt()` so a stale click surfaces as an error banner plus a
 * resync, never an unhandled rejection that white-screens the window.
 */

import { create } from 'zustand'
import type {
  FlowdoApi,
  Project,
  ProjectUpdate,
  Subtask,
  SubtaskUpdate,
  TaskCreate,
  TaskUpdate,
  TaskWithStats
} from '@shared/types'

/** The completed list is a recent-history view, not an archive. */
const COMPLETED_LIMIT = 100

const BRIDGE_MISSING = 'The app bridge is not available yet.'

/**
 * Preload injects `window.flowdo` before the document runs, but React StrictMode
 * double-mounts in dev and hot reloads re-run effects, so treat it as possibly-absent
 * rather than asserting on it.
 */
function api(): FlowdoApi | null {
  if (typeof window === 'undefined') return null
  return (window as Partial<Window>).flowdo ?? null
}

async function waitForApi(timeoutMs = 3000): Promise<FlowdoApi | null> {
  const deadline = Date.now() + timeoutMs
  let bridge = api()
  while (!bridge && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    bridge = api()
  }
  return bridge
}

/**
 * Electron wraps a main-process throw as
 * `Error invoking remote method 'tasks:update': Error: tasks: no task with id 7`.
 * Only the tail of that means anything to a user.
 */
function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const marker = raw.lastIndexOf('Error: ')
  return marker >= 0 ? raw.slice(marker + 'Error: '.length) : raw
}

function tally(tasks: TaskWithStats[]): Record<number, number> {
  const counts: Record<number, number> = {}
  for (const task of tasks) {
    counts[task.projectId] = (counts[task.projectId] ?? 0) + 1
  }
  return counts
}

export interface TasksState {
  projects: Project[]
  /** null = the "All tasks" pseudo-project. */
  selectedProjectId: number | null
  /** Open tasks for the current selection, in persisted sort order. */
  tasks: TaskWithStats[]
  completedTasks: TaskWithStats[]
  /** Open task count per project id, for the sidebar badges. */
  openCounts: Record<number, number>
  /** Total open tasks across every project — the "All tasks" badge. */
  openTotal: number
  /** Task open in the detail drawer. */
  selectedTaskId: number | null
  /** Subtasks of `selectedTaskId` only; loaded on demand. */
  subtasks: Subtask[]
  /** The timer's focus target, mirrored from main. Separate from `selectedTaskId`. */
  focusTaskId: number | null
  showCompleted: boolean
  /** True for the initial load and project switches, not for individual mutations. */
  loading: boolean
  error: string | null
  ready: boolean
}

export interface TasksActions {
  init: () => Promise<void>
  dispose: () => void
  clearError: () => void

  selectProject: (projectId: number | null) => Promise<void>
  /** Opens the detail drawer AND points the timer at the task. */
  selectTask: (taskId: number | null) => Promise<void>
  toggleShowCompleted: () => Promise<void>

  refreshProjects: () => Promise<void>
  /** Call after a focus session ends: `actualPomodoros` and `focusMs` moved server-side. */
  refreshTasks: () => Promise<void>
  refreshCompleted: () => Promise<void>
  refreshSubtasks: () => Promise<void>

  createProject: (name: string, color?: string) => Promise<Project | null>
  updateProject: (id: number, patch: ProjectUpdate) => Promise<void>
  deleteProject: (id: number) => Promise<void>

  createTask: (input: TaskCreate) => Promise<TaskWithStats | null>
  updateTask: (id: number, patch: TaskUpdate) => Promise<void>
  setTaskCompleted: (id: number, completed: boolean) => Promise<void>
  deleteTask: (id: number) => Promise<void>
  /** `ids` in their new order; applied optimistically and rolled back on failure. */
  reorderTasks: (ids: number[]) => Promise<void>

  createSubtask: (taskId: number, title: string) => Promise<void>
  updateSubtask: (id: number, patch: SubtaskUpdate) => Promise<void>
  deleteSubtask: (id: number) => Promise<void>

  setFocusTask: (taskId: number | null) => Promise<void>
}

export type TasksStore = TasksState & TasksActions

const INITIAL: TasksState = {
  projects: [],
  selectedProjectId: null,
  tasks: [],
  completedTasks: [],
  openCounts: {},
  openTotal: 0,
  selectedTaskId: null,
  subtasks: [],
  focusTaskId: null,
  showCompleted: false,
  loading: true,
  error: null,
  ready: false
}

/**
 * Subscriptions live outside the store: they are process-level resources, and holding
 * them in state would turn every timer tick into a state update.
 */
let unsubscribers: Array<() => void> = []
/** Bumped by dispose() so an in-flight init() can tell it has been superseded. */
let generation = 0

export const useTasksStore = create<TasksStore>((set, get) => {
  /** Re-read everything a failed mutation might have invalidated. */
  async function resync(): Promise<void> {
    await get().refreshProjects()
    await get().refreshTasks()
    await get().refreshCompleted()
  }

  /** Run a mutation and return its result, or null once the failure has been surfaced. */
  async function attemptValue<T>(work: (bridge: FlowdoApi) => Promise<T>): Promise<T | null> {
    const bridge = api()
    if (!bridge) {
      set({ error: BRIDGE_MISSING })
      return null
    }
    try {
      return await work(bridge)
    } catch (error) {
      set({ error: messageOf(error) })
      // The usual cause is local state describing a row that no longer exists.
      await resync()
      return null
    }
  }

  async function attempt(work: (bridge: FlowdoApi) => Promise<unknown>): Promise<boolean> {
    const outcome = await attemptValue(async (bridge) => {
      await work(bridge)
      return true as const
    })
    return outcome === true
  }

  /** A read that must not clobber good data when it fails. */
  async function read(work: (bridge: FlowdoApi) => Promise<void>): Promise<void> {
    const bridge = api()
    if (!bridge) return
    try {
      await work(bridge)
    } catch (error) {
      set({ error: messageOf(error) })
    }
  }

  return {
    ...INITIAL,

    async init() {
      const mine = ++generation
      const bridge = await waitForApi()
      if (mine !== generation) return
      if (!bridge) {
        set({ loading: false, error: 'Could not reach the app bridge.' })
        return
      }

      // The timer owns the focus target; the timer panel can move it. Ticks only arrive
      // while a session runs, so read the state once up front as well.
      unsubscribers.push(
        bridge.timer.onTick((state) => {
          if (get().focusTaskId !== state.taskId) set({ focusTaskId: state.taskId })
        })
      )
      // A finished focus session changes actualPomodoros/focusMs in the DB, so the rows on
      // screen are stale the moment the phase ends. Integration also calls refreshTasks();
      // doing it here too is idempotent and keeps the panel honest if that is ever missed.
      unsubscribers.push(
        bridge.timer.onPhaseEnd((event) => {
          if (event.kind === 'focus') {
            void get().refreshTasks()
            void get().refreshCompleted()
          }
        })
      )

      await read(async (b) => {
        const [projects, allOpen, timer] = await Promise.all([
          b.projects.list(),
          b.tasks.list(),
          b.timer.getState()
        ])
        if (mine !== generation) return
        const selected = get().selectedProjectId
        set({
          projects,
          tasks: selected == null ? allOpen : allOpen.filter((t) => t.projectId === selected),
          openCounts: tally(allOpen),
          openTotal: allOpen.length,
          focusTaskId: timer.taskId
        })
      })
      await get().refreshCompleted()
      if (mine !== generation) return
      set({ loading: false, ready: true })
    },

    dispose() {
      generation += 1
      for (const off of unsubscribers) off()
      unsubscribers = []
      set({ ready: false })
    },

    clearError() {
      set({ error: null })
    },

    async selectProject(projectId) {
      // Detail selection is per-project; the timer target deliberately is not — you can
      // browse another project without losing what you are counting time against.
      set({ selectedProjectId: projectId, selectedTaskId: null, subtasks: [], loading: true })
      await get().refreshTasks()
      await get().refreshCompleted()
      set({ loading: false })
    },

    async selectTask(taskId) {
      set({ selectedTaskId: taskId, subtasks: [] })
      if (taskId == null) return
      await get().refreshSubtasks()
      await get().setFocusTask(taskId)
    },

    async toggleShowCompleted() {
      const next = !get().showCompleted
      set({ showCompleted: next })
      if (next) await get().refreshCompleted()
    },

    async refreshProjects() {
      await read(async (bridge) => {
        const projects = await bridge.projects.list()
        const selected = get().selectedProjectId
        // The selected project may have been deleted from under us.
        const stillThere = selected == null || projects.some((p) => p.id === selected)
        set({ projects, selectedProjectId: stillThere ? selected : null })
      })
    },

    async refreshTasks() {
      await read(async (bridge) => {
        // One full read serves both the list and the sidebar counts. A global
        // `ORDER BY sort_order, id` filtered by project is the same order as a per-project
        // query, so filtering locally is not a reordering.
        const allOpen = await bridge.tasks.list()
        const selected = get().selectedProjectId
        set({
          tasks: selected == null ? allOpen : allOpen.filter((t) => t.projectId === selected),
          openCounts: tally(allOpen),
          openTotal: allOpen.length
        })
      })
    },

    async refreshCompleted() {
      await read(async (bridge) => {
        const completedTasks = await bridge.tasks.listCompleted(
          get().selectedProjectId,
          COMPLETED_LIMIT
        )
        set({ completedTasks })
      })
    },

    async refreshSubtasks() {
      const taskId = get().selectedTaskId
      if (taskId == null) {
        set({ subtasks: [] })
        return
      }
      await read(async (bridge) => {
        const subtasks = await bridge.subtasks.list(taskId)
        // The selection may have moved on while the read was in flight.
        if (get().selectedTaskId === taskId) set({ subtasks })
      })
    },

    async createProject(name, color) {
      const created = await attemptValue((bridge) =>
        bridge.projects.create(color ? { name, color } : { name })
      )
      if (created) await get().refreshProjects()
      return created
    },

    async updateProject(id, patch) {
      if (await attempt((bridge) => bridge.projects.update(id, patch))) {
        await get().refreshProjects()
      }
    },

    async deleteProject(id) {
      if (!(await attempt((bridge) => bridge.projects.remove(id)))) return
      // Fall back to "All tasks" rather than guessing at a replacement project.
      set({
        selectedProjectId: get().selectedProjectId === id ? null : get().selectedProjectId,
        selectedTaskId: null,
        subtasks: []
      })
      await resync()
    },

    async createTask(input) {
      const created = await attemptValue((bridge) => bridge.tasks.create(input))
      if (created) await get().refreshTasks()
      return created
    },

    async updateTask(id, patch) {
      if (!(await attempt((bridge) => bridge.tasks.update(id, patch)))) return
      await get().refreshTasks()
      // The detail drawer can edit a completed task too.
      if (get().completedTasks.some((t) => t.id === id)) await get().refreshCompleted()
    },

    async setTaskCompleted(id, completed) {
      if (!(await attempt((bridge) => bridge.tasks.setCompleted(id, completed)))) return
      // Completing the task you are timing leaves the timer pointing at a row you can no
      // longer see; drop the target so the next one is a deliberate choice.
      if (completed && get().focusTaskId === id) await get().setFocusTask(null)
      if (completed && get().selectedTaskId === id) set({ selectedTaskId: null, subtasks: [] })
      await get().refreshTasks()
      await get().refreshCompleted()
    },

    async deleteTask(id) {
      if (!(await attempt((bridge) => bridge.tasks.remove(id)))) return
      if (get().focusTaskId === id) await get().setFocusTask(null)
      if (get().selectedTaskId === id) set({ selectedTaskId: null, subtasks: [] })
      await get().refreshTasks()
      await get().refreshCompleted()
    },

    async reorderTasks(ids) {
      const previous = get().tasks
      const byId = new Map(previous.map((task) => [task.id, task]))
      const next: TaskWithStats[] = []
      for (const id of ids) {
        const task = byId.get(id)
        if (task) next.push(task)
      }
      // A caller working from a stale list would silently drop rows; resync instead.
      if (next.length !== previous.length) {
        await get().refreshTasks()
        return
      }

      set({ tasks: next })
      const bridge = api()
      if (!bridge) {
        set({ tasks: previous, error: BRIDGE_MISSING })
        return
      }
      try {
        await bridge.tasks.reorder(ids)
      } catch (error) {
        // Put the rows back where they were rather than leaving the screen disagreeing
        // with the database about the order.
        set({ tasks: previous, error: messageOf(error) })
        await get().refreshTasks()
      }
    },

    async createSubtask(taskId, title) {
      if (!(await attempt((bridge) => bridge.subtasks.create({ taskId, title })))) return
      await get().refreshSubtasks()
      // subtaskTotal lives on the task row, so the list is stale as well.
      await get().refreshTasks()
    },

    async updateSubtask(id, patch) {
      if (!(await attempt((bridge) => bridge.subtasks.update(id, patch)))) return
      await get().refreshSubtasks()
      await get().refreshTasks()
    },

    async deleteSubtask(id) {
      if (!(await attempt((bridge) => bridge.subtasks.remove(id)))) return
      await get().refreshSubtasks()
      await get().refreshTasks()
    },

    async setFocusTask(taskId) {
      const previous = get().focusTaskId
      set({ focusTaskId: taskId })
      const bridge = api()
      if (!bridge) return
      try {
        await bridge.timer.setTask(taskId)
      } catch (error) {
        set({ focusTaskId: previous, error: messageOf(error) })
      }
    }
  }
})
