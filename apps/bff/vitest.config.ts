import { defineConfig } from 'vitest/config';

/**
 * Tests live in tests/unit and tests/integration (issue #48), never in src/ — so the
 * include glob is stated rather than left to vitest's own default (which would also match
 * a stray *.test.ts dropped back into src/ by habit, silently reviving the layout this
 * moved away from).
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts']
  }
});
