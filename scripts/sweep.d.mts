/**
 * Type declarations for `sweep.mjs`'s exported pure functions, so `tests/sweep.test.ts`
 * (checked under `tsconfig.node.json`, which has `strict` on) can import the `.mjs` file
 * with full types instead of falling back to `any`.
 */

export interface Violation {
  file: string
  line: number
  rule: string
  message: string
  /** The offending source line (or, for a commit violation, the commit message) — what an
   *  allowlist entry's `match` is tested against. Not part of the printed output. */
  context: string
}

export interface AllowlistEntry {
  rule: string
  file: string
  match: string
  reason: string
}

export interface CommitRecord {
  hash: string
  message: string
}

export interface AllowlistResult {
  /** Violations left after suppression, with unused allowlist entries appended as
   *  `stale-allowlist` violations. */
  violations: Violation[]
  /** The allowlist entries that did not match anything on this run. */
  stale: AllowlistEntry[]
}

export declare function scanSource(file: string, content: string): Violation[]
export declare function checkCommitMessages(commits: CommitRecord[]): Violation[]
export declare function parseCommitLog(raw: string): CommitRecord[]
export declare function applyAllowlist(
  violations: Violation[],
  allowlist: AllowlistEntry[]
): AllowlistResult
export declare function validateAllowlist(allowlist: unknown): asserts allowlist is AllowlistEntry[]
