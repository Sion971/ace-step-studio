import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { environment: 'happy-dom', globals: true, include: ['**/*.test.ts', '**/*.test.tsx'], passWithNoTests: true },
});
