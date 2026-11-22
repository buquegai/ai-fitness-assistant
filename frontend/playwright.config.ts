import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:8001', headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined, viewport: { width: 1440, height: 960 }, trace: 'retain-on-failure' },
  reporter: 'list',
  webServer: {
    command: 'uv run --project .. uvicorn app.main:app --app-dir ../backend --host 127.0.0.1 --port 8001',
    url: 'http://127.0.0.1:8001/api/health',
    timeout: 60000,
    env: { DATABASE_PATH: 'data/browser-tests.sqlite3', DEEPSEEK_API_KEY: '', TAVILY_API_KEY: '',
      ALLOWED_ORIGINS: 'http://127.0.0.1:8001' },
    reuseExistingServer: false,
  },
});
