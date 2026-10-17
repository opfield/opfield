import { readdirSync, readFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { defineConfig } from 'vitest/config';

const TEST_ROOTS = ['src', 'tests'];
// Anything that changes module or process state for the rest of the file's worker.
const STATEFUL_TEST =
  /vi\.(mock|doMock|spyOn|stubEnv|stubGlobal|useFakeTimers|resetModules)|container\.(register|registerInstance|reset|clearInstances)|process\.env\.\w+\s*=|globalThis\./;

function testFiles(directory: string): string[] {
  return readdirSync(path.resolve(__dirname, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return testFiles(relative);
    return entry.name.endsWith('.test.ts') ? [relative] : [];
  });
}

// Tests that neither mock nor touch shared state run without per-file isolation, so each worker
// evaluates the schema and scope catalog once instead of once per file.
const sharedGraphTests = TEST_ROOTS.flatMap(testFiles).filter(
  (file) => !file.includes('.database.') && !STATEFUL_TEST.test(readFileSync(path.resolve(__dirname, file), 'utf8'))
);

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Every file gets the decorator metadata polyfill tsyringe needs, so a file of the shared project never depends on
    // an earlier file of its worker having loaded it.
    setupFiles: [createRequire(import.meta.url).resolve('reflect-metadata')],
    // Worker threads start faster than forked processes; the suite has no process-level state.
    pool: 'threads',
    projects: [
      {
        extends: true,
        test: {
          name: 'isolated',
          include: TEST_ROOTS.map((root) => `${root}/**/*.test.ts`),
          exclude: sharedGraphTests,
        },
      },
      { extends: true, test: { name: 'shared', include: sharedGraphTests, isolate: false } },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules', 'dist', 'src/db/migrations'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
