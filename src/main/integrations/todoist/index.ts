/**
 * Public surface of the Todoist integration. See `.claude/plans/v0.3-integrations.md` for
 * the sync algorithm and the frozen decisions this implements.
 */

export { createTodoistIntegration } from './engine'
export type { TodoistDeps, TodoistIntegration } from './engine'

export {
  onLocalSubtaskCreated,
  onLocalSubtaskRemoved,
  onLocalSubtaskUpdated,
  onLocalTaskCompleted,
  onLocalTaskCreated,
  onLocalTaskMoved,
  onLocalTaskRemoved,
  onLocalTaskUpdated
} from './outbox'
