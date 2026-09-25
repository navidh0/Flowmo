/**
 * updates — a test profile (FLOWDO_USER_DATA_DIR set) always reports `unsupported` with
 * reason `test-profile`, both from the API and in the Settings → Updates section.
 */

import { launch, quit, makeProfile, makeReporter, sleep } from '../lib/harness.mjs'

export async function run() {
  const { check, results } = makeReporter('updates')
  const profile = makeProfile('flowdo-e2e-updates-')

  let app
  try {
    const launched = await launch({ profile })
    app = launched.app
    const page = launched.page

    const status = await page.evaluate(() => window.flowdo.updates.getStatus())
    check(
      'updates.getStatus() is unsupported/test-profile',
      status.state === 'unsupported' && status.reason === 'test-profile',
      JSON.stringify(status)
    )

    const version = await page.evaluate(() => window.flowdo.app.getVersion())

    await page.click('[aria-label="Settings"]')
    await sleep(500)

    const body = await page.evaluate(() => document.body.innerText)
    check('Settings → Updates shows the test-profile copy', body.includes('Updates are off on test profiles.'), body.match(/Updates are off[^\n]*/)?.[0] ?? '(not found)')
    check('Settings → Updates shows the running version', body.includes(`Flowdo ${version}`), version)
  } finally {
    if (app) await quit(app)
    profile.cleanup()
  }

  return results
}
