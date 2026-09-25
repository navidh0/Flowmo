import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Tests cover src/shared/** only — pure logic, no Electron. Anything needing a
// BrowserWindow belongs in the manual verification pass, not here.
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') }
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Most suites open a fresh on-disk SQLite database per test and run every migration.
    // On the Windows CI runner that alone costs 0.3–0.9 s per test with files running in
    // parallel, so the slowest sync test can pass 5 s on a busy runner without anything
    // being wrong. A genuine hang still fails, just at 30 s instead of 5.
    testTimeout: process.platform === 'win32' ? 30_000 : 5_000,
    hookTimeout: process.platform === 'win32' ? 30_000 : 10_000
  }
})
