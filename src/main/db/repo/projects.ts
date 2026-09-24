import type { Project, ProjectCreate, ProjectUpdate } from '@shared/types'
import {
  bool,
  getDb,
  num,
  rowId,
  scalarNum,
  str,
  strOrNull,
  syncSourceOrNull,
  toInt,
  type Row
} from '../index'

/**
 * New projects cycle through this so two projects created back to back never share a
 * colour — the colour is what identifies a project in the stats breakdown, so a
 * duplicate makes the chart unreadable.
 */
const PALETTE = [
  '#6366f1',
  '#22c55e',
  '#f59e0b',
  '#ec4899',
  '#06b6d4',
  '#a855f7',
  '#ef4444',
  '#84cc16'
] as const

const COLUMNS = 'id, name, color, archived, sort_order, created_at, source, external_id'

function mapProject(row: Row): Project {
  return {
    id: num(row, 'id'),
    name: str(row, 'name'),
    color: str(row, 'color'),
    archived: bool(row, 'archived'),
    sortOrder: num(row, 'sort_order'),
    createdAt: num(row, 'created_at'),
    source: syncSourceOrNull(row, 'source'),
    externalId: strOrNull(row, 'external_id')
  }
}

function requireProject(id: number): Project {
  const project = find(id)
  if (!project) throw new Error(`projects: no project with id ${id}`)
  return project
}

function find(id: number): Project | null {
  const row = getDb().prepare(`SELECT ${COLUMNS} FROM projects WHERE id = ?`).get(id)
  return row ? mapProject(row) : null
}

export function get(id: number): Project | null {
  return find(id)
}

export function list(includeArchived = false): Project[] {
  const sql = includeArchived
    ? `SELECT ${COLUMNS} FROM projects ORDER BY sort_order, id`
    : `SELECT ${COLUMNS} FROM projects WHERE archived = 0 ORDER BY sort_order, id`
  return getDb()
    .prepare(sql)
    .all()
    .map((row) => mapProject(row))
}

export function create(input: ProjectCreate): Project {
  // COALESCE covers the empty table: MAX() over no rows is NULL, not 0.
  const next = scalarNum('SELECT COALESCE(MAX(sort_order) + 1, 0) AS value FROM projects', [])
  const color = input.color ?? PALETTE[next % PALETTE.length] ?? '#6366f1'

  const result = getDb()
    .prepare(
      'INSERT INTO projects (name, color, archived, sort_order, created_at) VALUES (?, ?, 0, ?, ?)'
    )
    .run(input.name, color, next, Date.now())

  return requireProject(rowId(result.lastInsertRowid))
}

export function update(id: number, patch: ProjectUpdate): Project {
  const sets: string[] = []
  const values: Array<string | number> = []

  if (patch.name !== undefined) {
    sets.push('name = ?')
    values.push(patch.name)
  }
  if (patch.color !== undefined) {
    sets.push('color = ?')
    values.push(patch.color)
  }
  if (patch.archived !== undefined) {
    sets.push('archived = ?')
    values.push(toInt(patch.archived))
  }
  if (patch.sortOrder !== undefined) {
    sets.push('sort_order = ?')
    values.push(patch.sortOrder)
  }

  if (sets.length > 0) {
    getDb()
      .prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values, id)
  }

  return requireProject(id)
}

/** Cascades to tasks and subtasks; sessions keep their time and lose the reference. */
export function remove(id: number): void {
  getDb().prepare('DELETE FROM projects WHERE id = ?').run(id)
}
