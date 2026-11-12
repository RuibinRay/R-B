import { defineConfig } from 'vitest/config';

// The tests cover the signal-processing and arrangement code, which needs no browser.
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], testTimeout: 180000, environment: 'node' },
});
