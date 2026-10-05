import { web } from '@e2e-dev/web'
import type { E2EConfig } from 'e2e'

const url = process.env.FIXTURE_URL
if (!url) throw new Error('FIXTURE_URL must name the qualification server')

export default {
  targets: [{ name: 'chromium', engine: web(), app: { url } }],
  tests: ['journeys.e2e.mts'],
  workers: 1,
  retries: 0,
  timeout: 15000,
  assertionTimeout: 1000,
  trace: 'on',
  video: 'off',
  reporters: ['json'],
} satisfies E2EConfig
