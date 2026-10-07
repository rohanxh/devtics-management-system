import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 120000,
    fileParallelism: true,
    env: { DMS_FAST_HASH: '1', NODE_ENV: 'test' },
  },
});
