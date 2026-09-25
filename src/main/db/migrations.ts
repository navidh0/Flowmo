/**
 * Forward-only schema migrations, keyed off `PRAGMA user_version`.
 *
 * No `_migrations` table: SQLite already carries a 32-bit integer in the file header for
 * exactly this, and it cannot drift out of sync with the schema it describes.
 *
 * Rules for adding one: append a new entry with the next version, never edit an existing
 * `up()`. A shipped migration has already run on someone's machine, so changing it makes
 * two installs with the same `user_version` mean different things.
 */

import type { DatabaseSync } from 'node:sqlite'

export interface Migration {
  version: number
  up(db: DatabaseSync): void
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE projects (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT    NOT NULL,
          color      TEXT    NOT NULL,
          archived   INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE tasks (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          title               TEXT    NOT NULL,
          notes               TEXT,
          priority            INTEGER NOT NULL DEFAULT 3,
          due_date            TEXT,
          estimated_pomodoros INTEGER,
          sort_order          INTEGER NOT NULL,
          completed_at        INTEGER,
          created_at          INTEGER NOT NULL
        );

        CREATE TABLE subtasks (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          title      TEXT    NOT NULL,
          done       INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL
        );

        -- The two foreign keys are ON DELETE SET NULL, not CASCADE: deleting a task or a
        -- project must never erase the fact that the time was spent. An orphaned session
        -- still counts toward your totals and your streak.
        CREATE TABLE sessions (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id     INTEGER REFERENCES tasks(id)    ON DELETE SET NULL,
          project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
          mode        TEXT    NOT NULL,
          kind        TEXT    NOT NULL,
          started_at  INTEGER NOT NULL,
          ended_at    INTEGER NOT NULL,
          planned_ms  INTEGER,
          actual_ms   INTEGER NOT NULL,
          completed   INTEGER NOT NULL DEFAULT 1,
          interrupted INTEGER NOT NULL DEFAULT 0,
          notes       TEXT
        );

        CREATE TABLE settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE INDEX idx_sessions_started        ON sessions(started_at);
        CREATE INDEX idx_sessions_project_started ON sessions(project_id, started_at);
        CREATE INDEX idx_sessions_task           ON sessions(task_id);
        CREATE INDEX idx_tasks_project_completed  ON tasks(project_id, completed_at);
      `)

      // A task has to belong to a project, so there has to be one before the user makes
      // anything. Seeded here rather than on every launch: if they rename or delete it,
      // it should stay renamed or deleted.
      db.prepare(
        'INSERT INTO projects (name, color, archived, sort_order, created_at) VALUES (?, ?, 0, 0, ?)'
      ).run('Inbox', '#6366f1', Date.now())
    }
  },
  {
    // Integrations: Todoist (two-way) and iCal calendar feeds.
    version: 2,
    up(db) {
      db.exec(`
        -- Secrets are safeStorage ciphertext, never plaintext, and live in their own table so
        -- that nothing which reads the domain tables (export above all) can reach them by
        -- accident. Keys: 'todoist.token', 'ical.<feedId>.url' — an iCal secret address is a
        -- credential in its own right.
        CREATE TABLE credentials (
          key        TEXT    PRIMARY KEY,
          ciphertext BLOB    NOT NULL,
          updated_at INTEGER NOT NULL
        );

        -- source = NULL means created in Flowdo. The unique indexes are partial so that any
        -- number of local rows coexist, while a re-sync of the same upstream row updates it
        -- instead of duplicating it.
        ALTER TABLE projects ADD COLUMN source      TEXT;
        ALTER TABLE projects ADD COLUMN external_id TEXT;
        CREATE UNIQUE INDEX idx_projects_source_ext ON projects(source, external_id)
          WHERE source IS NOT NULL;

        ALTER TABLE tasks ADD COLUMN source            TEXT;
        ALTER TABLE tasks ADD COLUMN external_id       TEXT;
        -- The raw upstream due object (JSON). due_date keeps only the calendar day, which is
        -- all Flowdo models; this keeps the time and recurrence so a push that did not touch
        -- the due date can never flatten them on the provider's side.
        ALTER TABLE tasks ADD COLUMN remote_due        TEXT;
        ALTER TABLE tasks ADD COLUMN remote_updated_at INTEGER;
        -- Deleted upstream. Marked, never deleted here: the user decides, and sessions
        -- against the task must survive either way.
        ALTER TABLE tasks ADD COLUMN remote_deleted_at INTEGER;
        CREATE UNIQUE INDEX idx_tasks_source_ext ON tasks(source, external_id)
          WHERE source IS NOT NULL;

        ALTER TABLE subtasks ADD COLUMN source      TEXT;
        ALTER TABLE subtasks ADD COLUMN external_id TEXT;
        CREATE UNIQUE INDEX idx_subtasks_source_ext ON subtasks(source, external_id)
          WHERE source IS NOT NULL;

        -- Local edits to synced rows, pushed in id order before every pull. The uuid is the
        -- provider's command id, fixed at enqueue time, so a push retried after a network
        -- failure can never apply twice.
        CREATE TABLE sync_outbox (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          source     TEXT    NOT NULL,
          uuid       TEXT    NOT NULL UNIQUE,
          type       TEXT    NOT NULL,
          args       TEXT    NOT NULL,
          temp_id    TEXT,
          created_at INTEGER NOT NULL,
          attempts   INTEGER NOT NULL DEFAULT 0,
          last_error TEXT
        );
        CREATE INDEX idx_sync_outbox_source ON sync_outbox(source, id);

        CREATE TABLE sync_state (
          source        TEXT PRIMARY KEY,
          sync_token    TEXT,
          last_ok_at    INTEGER,
          last_error    TEXT,
          last_error_at INTEGER
        );

        CREATE TABLE calendar_feeds (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          name          TEXT    NOT NULL,
          color         TEXT    NOT NULL,
          enabled       INTEGER NOT NULL DEFAULT 1,
          etag          TEXT,
          last_modified TEXT,
          last_ok_at    INTEGER,
          last_error    TEXT,
          created_at    INTEGER NOT NULL
        );

        -- Expanded occurrences for a rolling window, replaced wholesale per feed on every
        -- successful refresh. A timed event carries instants; an all-day event carries
        -- calendar days and no instants, for the same reason tasks.due_date does.
        CREATE TABLE calendar_events (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          feed_id    INTEGER NOT NULL REFERENCES calendar_feeds(id) ON DELETE CASCADE,
          uid        TEXT    NOT NULL,
          title      TEXT    NOT NULL,
          location   TEXT,
          all_day    INTEGER NOT NULL,
          start_ms   INTEGER,
          end_ms     INTEGER,
          start_date TEXT,
          end_date   TEXT
        );
        CREATE INDEX idx_calendar_events_feed  ON calendar_events(feed_id);
        CREATE INDEX idx_calendar_events_start ON calendar_events(start_ms);
        CREATE INDEX idx_calendar_events_date  ON calendar_events(start_date);
      `)
    }
  },
  {
    // The zone a timed calendar event was defined in, so its original time can be shown
    // next to local time when the two differ. Existing cached rows read NULL until the
    // next refresh rewrites them, which is harmless: the label falls back to local only.
    version: 3,
    up(db) {
      db.exec('ALTER TABLE calendar_events ADD COLUMN tzid TEXT')
    }
  },
  {
    /**
     * Backfill: Flowmodoro focus is open-ended (plannedMs is always null for it) and by the
     * frozen contract (PhaseEndEvent.completed in shared/types.ts) is "always true (the user
     * chose to stop)" — it can never legitimately be logged `completed = 0`. Before the fix
     * to src/main/timer.ts, two call sites disagreed with that contract and logged it
     * `completed = 0` anyway: stop() (unconditionally `completed: false`) and
     * setMode(nextMode, 'keep') ending an in-flight phase (also unconditionally
     * `completed: false`). Both now route through timer.ts's `isPhaseComplete()` helper,
     * which returns true for any Flowmodoro-focus phase, so neither can produce this state
     * again.
     *
     * This is exact for every row already in the database: verified via
     * `git log -p -- src/main/timer.ts` (the file was introduced whole in a single commit,
     * 05b740f, so there is no earlier history to account for) that those were the only two
     * `completed: false` call sites reachable for Flowmodoro focus — skip() and takeBreak()
     * already computed `completed` correctly, and the tick-driven auto-end path
     * (`endPhase({ completed: true, ... })`) only ever fires when `isExpired(plannedMs, …)`
     * is true, which is never true for Flowmodoro focus since its plannedMs is null. And
     * verified via `grep -rn "sessionsRepo.create\|INSERT INTO sessions" src/main` that the
     * only other writer of `sessions` is dataio.ts's `applyImport()`, which is intentionally
     * excluded below.
     *
     * Known limitation, not handled: `applyImport()` writes whatever `completed` value an
     * export file contains, verbatim. This migration runs exactly once, at upgrade, so rows
     * imported later from an export file made before this fix would bring back
     * `completed = 0` Flowmodoro-focus rows that this backfill cannot see.
     */
    version: 4,
    up(db) {
      db.exec(
        `UPDATE sessions SET completed = 1
         WHERE mode = 'flowmodoro' AND kind = 'focus' AND completed = 0`
      )
    }
  }
]

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get()
  const value = row?.['user_version']
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return 0
}

/**
 * Apply every migration above the file's current version.
 *
 * The whole run is one transaction, so a half-applied schema is impossible: either the
 * database comes out at the target version or it is untouched and the app fails loudly
 * instead of writing into tables that only partly exist.
 */
export function runMigrations(db: DatabaseSync): void {
  const current = readUserVersion(db)
  const pending = MIGRATIONS.filter((m) => m.version > current).sort(
    (a, b) => a.version - b.version
  )
  if (pending.length === 0) return

  db.exec('BEGIN')
  try {
    for (const migration of pending) {
      // PRAGMA cannot take a bound parameter, so the version is interpolated — checked
      // here rather than trusted, since interpolation is interpolation.
      if (!Number.isInteger(migration.version)) {
        throw new Error(`db: migration version ${String(migration.version)} is not an integer`)
      }
      migration.up(db)
      db.exec(`PRAGMA user_version = ${migration.version}`)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
