import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: process.env.DATABASE_URL || 'postgres://longevity:longevity_dev@localhost:5432/longevity',
      SESSION_SECRET: process.env.SESSION_SECRET || 'test-session-secret-32-bytes-long!',
      PASSWORD_PEPPER: 'test-custom-pepper-for-vitest-suite-32b',
      NODE_ENV: 'test',
    },
  },
});
