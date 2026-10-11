import { ApiClient } from './api-client.js';
import { loadConfig } from './config.js';
import { cleanupSeededIdentity, seedApiToken } from './db-token.js';
import { scenarios } from './scenarios.js';
import { runTests, type TestContext } from './test-harness.js';

const releaseUpgradeScenarios = new Set([
  'health endpoint reports dependency status',
  'OpenAPI is reachable and legacy nginx management routes are absent',
  'API token is rejected from browser-session-only surfaces',
  'connected PostgreSQL databases allow safe read-only query checks',
]);

export function selectScenarios(profile: 'full' | 'release-upgrade') {
  return profile === 'release-upgrade' ? scenarios.filter(({ name }) => releaseUpgradeScenarios.has(name)) : scenarios;
}

async function main() {
  const config = loadConfig();
  const { pool, seeded } = await seedApiToken(config.databaseUrl);
  const ctx: TestContext = {
    client: new ApiClient(config.apiUrl, seeded.token),
    config,
    db: pool,
    cleanup: [],
  };

  console.log(`Opfield API URL: ${config.apiUrl}`);
  console.log(`Seeded API token ${seeded.tokenId} with ${seeded.scopes.length} delegable scopes`);
  if (config.keepToken) {
    console.log(`Seeded token: ${seeded.token}`);
  }

  try {
    await runTests(ctx, selectScenarios(config.profile));
  } finally {
    for (const cleanup of ctx.cleanup.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        console.error('Cleanup failed:', error instanceof Error ? error.message : error);
        process.exitCode = 1;
      }
    }
    if (!config.keepToken) {
      await cleanupSeededIdentity(pool, seeded).catch((error) => {
        console.error('Failed to remove seeded e2e identity:', error instanceof Error ? error.message : error);
        process.exitCode = 1;
      });
    }
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
