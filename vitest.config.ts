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
    environment: 'node'
  }
})
