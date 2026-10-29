import { describe, expect, it } from 'vitest';
import { buildHostingBootstrap } from './hosting-bootstrap.js';

const token = 'opf_node_v2_0123456789abcdef_secretsecretsecretsecretsecretsecret';

function bootstrap(role: 'docker' | 'databases') {
  return buildHostingBootstrap({
    role,
    opfieldAddress: 'opfield.example.com:9443',
    token,
    certificateFingerprint: `sha256:${'a'.repeat(64)}`,
    installers: {
      release: 'v2.12.9',
      baseUrl: 'https://get.opfield.dev/opfield/releases/download/v2.12.9',
      sha256: { 'setup-docker-node.sh': 'b'.repeat(64), 'setup-database-node.sh': 'c'.repeat(64) },
      daemonVersion: null,
    },
  });
}

describe('buildHostingBootstrap', () => {
  it('hands the enrollment token to the installer through its environment, never its command line', () => {
    for (const role of ['docker', 'databases'] as const) {
      const script = bootstrap(role);
      const run = script.split('\n').find((line) => line.includes('bash "$installer"'));
      expect(run).toBeDefined();
      expect(run).toMatch(new RegExp(`^OPFIELD_NODE_TOKEN='${token}' bash "\\$installer" `));
      expect(run!.slice(run!.indexOf('bash "$installer"'))).not.toContain(token);
      expect(script).not.toContain('--token');
    }
  });
});
