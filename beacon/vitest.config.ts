import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    testTimeout: 10_000,
  },
});
