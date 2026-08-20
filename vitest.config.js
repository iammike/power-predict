import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.js'],
    setupFiles: ['tests/setup.js'],
    // The default 5000ms is tight for the DOM-wiring integration tests
    // (#239): each mounts a fresh app.js instance against real
    // IndexedDB, and running the full suite in parallel (every spec
    // file doing this concurrently) has been observed to occasionally
    // push a single test's cumulative real-IO time past 5000ms even
    // though it settles in well under 1000ms in isolation.
    testTimeout: 15000,
  },
});
