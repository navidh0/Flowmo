/**
 * The task the timer is currently attributing time to.
 *
 * Resolved over IPC from the id on `TimerState` rather than read out of the task store: the
 * mini widget is a second renderer that never mounts the task list, and the timer surface must
 * not depend on someone else's store being initialised.
 */

import { useEffect, useState } from 'react'
import type { TaskWithStats } from '@shared/types'
import { useTimerStore } from '../../stores/timer'

export interface CurrentTask {
  taskId: number | null
  /** null while the fetch is in flight, or if the row has since been deleted. */
  task: TaskWithStats | null
}

export function useCurrentTask(): CurrentTask {
  const taskId = useTimerStore((s) => s.state.taskId)
  // Refetching when a phase ends keeps the title honest if the row was edited elsewhere.
  const phaseEndAt = useTimerStore((s) => s.lastPhaseEnd)
  const [task, setTask] = useState<TaskWithStats | null>(null)

  useEffect(() => {
    if (taskId == null) {
      setTask(null)
      return
    }

    const api = window.flowdo
    if (!api) return

    let live = true
    void api.tasks
      .get(taskId)
      .then((row) => {
        if (live) setTask(row)
      })
      .catch(() => {
        if (live) setTask(null)
      })

    return () => {
      live = false
    }
  }, [taskId, phaseEndAt])

  return { taskId, task }
}
