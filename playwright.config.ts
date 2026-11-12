import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E Configuration for Friction Determinism UXOps Platform.
 * Tests emulate real user chaos (Rage clicks, navigation loops, schema corruption)
 * to assert deterministic telemetry signals and progressive delivery rollbacks.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1, // Run sequentially for deterministic telemetry state validation
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:5001',
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run build:frontend && PORT=5001 node backend/server.js',
    url: 'http://localhost:5001/health',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});

