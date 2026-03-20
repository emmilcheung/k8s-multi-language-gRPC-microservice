import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.integration.spec.ts'],
    environment: 'node',
    // Integration tests run sequentially (Testcontainers — one DB container)
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  plugins: [swc.vite({ module: { type: 'nodenext' } })],
});
