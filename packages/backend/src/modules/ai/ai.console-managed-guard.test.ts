import { describe, expect, it } from 'vitest';
import { consoleCommands, shellStringCommands } from './ai.console-commands.js';
import { consoleMutations } from './ai.console-docker-mutations.js';
import {
  emptyInventory,
  evaluateConsoleMutations,
  MANAGED_RESOURCE_CONSOLE_FORBIDDEN,
  managedResourceConsoleError,
} from './ai.console-managed-guard.js';
import type { ManagedInventory } from './ai.console-managed-inventory.js';

const mutationsOf = (argv: string[]) => consoleMutations(consoleCommands(argv));

describe('console command classifier', () => {
  const mutating: Array<[string, string[], Record<string, unknown>]> = [
    ['plain rm', ['docker', 'rm', '-f', 'web'], { kind: 'container', containers: ['web'] }],
    ['management form', ['docker', 'container', 'rm', 'web'], { kind: 'container', verb: 'container rm' }],
    ['flag after target', ['docker', 'stop', 'web', '-t', '5'], { kind: 'container', containers: ['web'] }],
    ['sh -c chain', ['sh', '-c', 'docker ps; docker rm -f web || true'], { containers: ['web'] }],
    ['bash -lc with sudo', ['bash', '-lc', 'sudo -u root -E docker stop web'], { verb: 'stop', containers: ['web'] }],
    ['env prefix', ['sh', '-c', 'DOCKER_HOST=unix:///var/run/docker.sock docker rm web'], { containers: ['web'] }],
    ['env wrapper', ['env', '-i', 'PATH=/usr/bin', 'docker', 'kill', 'web'], { verb: 'kill', containers: ['web'] }],
    ['-H to the local socket', ['docker', '-H', 'unix:///var/run/docker.sock', 'rm', 'web'], { containers: ['web'] }],
    ['--context', ['docker', '--context', 'default', 'restart', 'web'], { verb: 'restart', containers: ['web'] }],
    ['absolute binary', ['/usr/bin/docker', 'pause', 'web'], { verb: 'pause', containers: ['web'] }],
    ['nsenter into host', ['nsenter', '-t', '1', '-m', '--', 'docker', 'rm', 'web'], { containers: ['web'] }],
    ['timeout and nohup', ['sh', '-c', 'nohup timeout 30 docker stop web &'], { containers: ['web'] }],
    ['eval string', ['sh', '-c', "eval 'docker unpause web'"], { verb: 'unpause', containers: ['web'] }],
    ['su -c', ['su', '-', 'root', '-c', 'docker rename web web-old'], { containers: ['web'], name: 'web-old' }],
    ['piped into sh', ['sh', '-c', 'echo "docker rm web" | sh'], { containers: ['web'] }],
    ['heredoc into bash', ['bash', '-c', 'bash <<EOF\ndocker rm web\nEOF\n'], { containers: ['web'] }],
    ['command substitution', ['sh', '-c', 'echo $(docker rm web)'], { containers: ['web'] }],
    ['podman', ['podman', 'container', 'stop', 'web'], { containers: ['web'] }],
    ['nerdctl update', ['nerdctl', 'update', '--memory', '1g', 'web'], { verb: 'update', containers: ['web'] }],
    ['xargs', ['sh', '-c', 'docker ps -q | xargs docker rm -f'], { kind: 'container', unresolved: true }],
    ['substituted targets', ['sh', '-c', 'docker rm -f $(docker ps -aq)'], { kind: 'container', unresolved: true }],
    ['variable target', ['sh', '-c', 'docker stop "$NAME"'], { kind: 'container', unresolved: true }],
    ['podman --all', ['podman', 'rm', '-a'], { kind: 'container', unresolved: true }],
    ['run with name', ['docker', 'run', '-d', '--name', 'web', 'nginx'], { kind: 'run', name: 'web' }],
    ['run attached name', ['docker', 'run', '-d', '--name=web', 'nginx', 'sh', '-c', 'x'], { name: 'web' }],
    [
      'run ports and volumes',
      ['docker', 'run', '-dit', '-p', '127.0.0.1:8080:80/tcp', '-v', 'shop_data:/data', 'nginx'],
      { kind: 'run', ports: [8080], volumes: ['shop_data'] },
    ],
    ['create --mount', ['docker', 'create', '--mount', 'type=volume,src=db,dst=/d', 'pg'], { volumes: ['db'] }],
    ['volumes-from', ['docker', 'run', '--volumes-from', 'web:ro', 'alpine'], { containers: ['web'] }],
    ['network disconnect', ['docker', 'network', 'disconnect', 'shop_default', 'web'], { kind: 'network' }],
    ['network rm', ['docker', 'network', 'rm', 'shop_default'], { networks: ['shop_default'] }],
    ['volume rm', ['docker', 'volume', 'rm', '-f', 'shop_data'], { kind: 'volume', volumes: ['shop_data'] }],
    ['volume prune', ['docker', 'volume', 'prune', '-af'], { kind: 'prune' }],
    ['system prune', ['docker', 'system', 'prune', '-af', '--volumes'], { kind: 'prune', verb: 'system prune' }],
    ['container prune', ['docker', 'container', 'prune', '-f'], { kind: 'prune' }],
    ['compose -p', ['docker', 'compose', '-p', 'shop', 'up', '-d'], { kind: 'compose', project: 'shop' }],
    ['compose in cd dir', ['sh', '-c', 'cd /srv/shop && docker compose down'], { project: 'shop' }],
    ['compose -f', ['docker', 'compose', '-f', '/srv/Shop/compose.yaml', 'pull'], { project: 'shop' }],
    ['compose env', ['sh', '-c', 'export COMPOSE_PROJECT_NAME=shop; docker-compose restart'], { project: 'shop' }],
    ['compose unknown dir', ['docker', 'compose', 'rm', '-f'], { kind: 'compose', project: null, unresolved: true }],
    ['state rm', ['sh', '-c', 'rm -rf /var/lib/docker-daemon/envstore/web.env'], { kind: 'state_path' }],
    ['state redirect', ['sh', '-c', 'echo {} > /var/lib/docker-daemon/x.json'], { verb: 'output redirection' }],
    [
      'state via cd',
      ['sh', '-c', 'cd /var/lib/docker-daemon && rm -r envstore'],
      { path: '/var/lib/docker-daemon/envstore' },
    ],
    ['state sed -i', ['sed', '-i', 's/a/b/', '/etc/docker-daemon/config.yaml'], { kind: 'state_path' }],
    ['docker data root', ['sudo', 'rm', '/var/lib/docker/containers/abc/config.v2.json'], { kind: 'state_path' }],
    ['find -delete', ['find', '/var/lib/docker-daemon', '-name', '*.env', '-delete'], { kind: 'state_path' }],
  ];
  it.each(mutating)('%s', (_label, argv, expected) => {
    expect(mutationsOf(argv)).toEqual(expect.arrayContaining([expect.objectContaining(expected)]));
  });

  const readOnly: Array<[string, string[]]> = [
    ['ps', ['docker', 'ps', '-a']],
    ['inspect', ['docker', 'inspect', 'web']],
    ['logs', ['docker', 'logs', '--tail', '50', 'web']],
    ['stats', ['docker', 'stats', '--no-stream']],
    ['images', ['docker', 'images']],
    ['exec', ['docker', 'exec', 'web', 'ls', '/']],
    ['grep pipeline', ['sh', '-c', 'docker ps --format "{{.Names}}" | grep web']],
    ['compose ps', ['docker', 'compose', '-p', 'shop', 'ps']],
    ['read state', ['cat', '/var/lib/docker-daemon/envstore/web.env']],
    ['copy state out', ['cp', '-r', '/var/lib/docker-daemon/envstore', '/tmp/backup']],
    ['sed without -i', ['sed', 's/a/b/', '/etc/docker-daemon/config.yaml']],
    ['command -v', ['sh', '-c', 'command -v docker && docker version']],
    ['echoed text', ['echo', 'docker rm web']],
  ];
  it.each(readOnly)('%s changes nothing', (_label, argv) => {
    expect(mutationsOf(argv)).toEqual([]);
  });

  it('reads SSH command strings as shell scripts', () => {
    expect(consoleMutations(shellStringCommands('cd /srv/shop; sudo docker compose up -d'))).toEqual([
      expect.objectContaining({ kind: 'compose', project: 'shop' }),
    ]);
  });
});

function inventory(overrides: Partial<ManagedInventory> = {}): ManagedInventory {
  return {
    ...emptyInventory(),
    containers: [
      { id: '1a2b3c4d5e6f', name: 'web', managed: true, kind: 'container', project: null, ports: [8080] },
      { id: '9f8e7d6c5b4a', name: 'shop-api-1', managed: true, kind: 'compose', project: 'shop', ports: [] },
      { id: 'abcdef012345', name: 'scratch', managed: false, kind: 'container', project: null, ports: [9000] },
    ],
    reservedNames: new Map([['api', 'its Git source']]),
    recordedNames: new Set(['web', 'shop-api-1', 'gone']),
    composeProjects: new Set(['shop']),
    volumes: new Set(['shop_data']),
    ...overrides,
  };
}

const refusalOf = (argv: string[], inv = inventory()) => evaluateConsoleMutations(mutationsOf(argv), inv);

describe('console managed-resource guard', () => {
  const refused: Array<[string, string[], string, string]> = [
    ['remove', ['docker', 'rm', '-f', 'web'], 'managed container "web"', 'remove_docker_container'],
    ['id prefix', ['docker', 'stop', '1a2b'], 'managed container "web"', 'stop_docker_container'],
    [
      'compose container',
      ['docker', 'restart', 'shop-api-1'],
      'managed container "shop-api-1"',
      'manage_docker_compose',
    ],
    ['recreate by name', ['docker', 'run', '-d', '--name', 'web', 'nginx'], 'managed container "web"', 'recreate'],
    ['reserved name', ['docker', 'create', '--name', 'api', 'img'], 'Git source', 'recreate'],
    ['removed managed name', ['docker', 'run', '--name', 'gone', 'img'], 'managed container "gone"', 'recreate'],
    ['managed port', ['docker', 'run', '-p', '8080:80', 'nginx'], 'host port 8080', 'recreate'],
    ['managed volume', ['docker', 'run', '-v', 'shop_data:/d', 'alpine'], 'managed volume "shop_data"', 'volume'],
    ['bulk targets', ['sh', '-c', 'docker rm -f $(docker ps -aq)'], 'only when it runs', 'remove_docker_container'],
    ['compose project', ['sh', '-c', 'cd /srv/shop && docker compose down'], 'Compose project "shop"', 'compose'],
    ['compose unknown', ['docker', 'compose', 'up', '-d'], 'cannot be told apart', 'compose'],
    ['prune', ['docker', 'system', 'prune', '-f'], 'system prune', 'remove_docker_container'],
    ['state path', ['rm', '/var/lib/docker-daemon/envstore/web.env'], '/var/lib/docker-daemon', 'Opfield tool'],
  ];
  it.each(refused)('refuses %s', (_label, argv, object, tool) => {
    const refusal = refusalOf(argv);
    expect(refusal?.object).toContain(object);
    expect(refusal?.tool).toContain(tool);
  });

  const allowed: Array<[string, string[]]> = [
    ['unmanaged container', ['docker', 'rm', '-f', 'scratch']],
    ['new container', ['docker', 'run', '-d', '--name', 'probe', '-p', '9100:80', 'nginx']],
    ['other compose project', ['docker', 'compose', '-p', 'sandbox', 'down']],
    ['read-only', ['sh', '-c', 'docker ps -a && docker logs web && docker inspect web']],
  ];
  it.each(allowed)('allows %s', (_label, argv) => {
    expect(refusalOf(argv)).toBeNull();
  });

  it('protects only daemon state on nodes without Opfield Docker workloads', () => {
    const noDocker = { ...emptyInventory(), noDocker: true };
    expect(refusalOf(['docker', 'rm', 'web'], noDocker)).toBeNull();
    expect(refusalOf(['rm', '-rf', '/etc/nginx-daemon/certs'], noDocker)?.object).toContain('/etc/nginx-daemon');
  });

  it('counts every container on storage and database nodes', () => {
    const storage = { ...emptyInventory(), containers: null, allManaged: true };
    expect(refusalOf(['docker', 'restart', 'pg-1'], storage)?.object).toBe('managed container "pg-1"');
    expect(refusalOf(['docker', 'run', '--rm', 'alpine', 'true'], storage)).toBeNull();
  });

  it('answers with the managed-resource code and the tool to use', () => {
    const refusal = refusalOf(['docker', 'rm', '-f', 'web'])!;
    const error = managedResourceConsoleError(refusal);
    expect(error.code).toBe(MANAGED_RESOURCE_CONSOLE_FORBIDDEN);
    expect(error.statusCode).toBe(403);
    expect(error.message).toContain('Use remove_docker_container');
  });
});
