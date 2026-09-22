// Extends vitest's `expect` with the DOM matchers (toBeDisabled, toHaveAttribute,
// toBeEmptyDOMElement, ...) every component test below reaches for. Loaded once via
// vite.config.ts's test.setupFiles rather than imported per file.
import '@testing-library/jest-dom/vitest';
