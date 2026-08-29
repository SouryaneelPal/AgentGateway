import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Phase 2+ tests hit a real Postgres; keep them serial so row locks are meaningful.
    fileParallelism: false,
  },
});
