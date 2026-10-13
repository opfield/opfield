import {
  hostMoveNewDir,
  planHostMove,
  readHostMoveState,
  runHostMove,
  TERMINAL_HOST_MOVE_PHASES,
} from '@/foundation/host-move.js';
import { DockerHostMoveHost } from '@/foundation/host-move-host.js';

/**
 * Moves an installation to the Opfield layout (foundation/host-move.ts). Runs in the `opfield-host-move` container,
 * which the app (once an update has settled) or install.sh starts with the Docker socket and the parent of the
 * install directory mounted at the same paths. Docker restarts it after a crash or reboot; it resumes the recorded
 * move. Exit codes: 0 done or nothing to do, 3 rolled back, 4 failed (needs an operator), 2 could not plan.
 *
 *   node dist/cli/host-move.js --dir /opt/gateway --project gateway --network gateway_default [--retry]
 */

interface Options {
  dir: string;
  project: string;
  network: string;
  retry: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Partial<Options> = { retry: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--retry') {
      options.retry = true;
      continue;
    }
    if ((arg === '--dir' || arg === '--project' || arg === '--network') && next) {
      options[arg.slice(2) as 'dir' | 'project' | 'network'] = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete host move argument: ${arg}`);
  }
  if (!options.dir || !/^\/[a-zA-Z0-9/_.-]+$/.test(options.dir)) throw new Error('--dir must be an absolute path');
  if (!options.project || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(options.project))
    throw new Error('--project is invalid');
  if (!options.network || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(options.network))
    throw new Error('--network is invalid');
  return options as Options;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const host = new DockerHostMoveHost();
  let state: Awaited<ReturnType<typeof readHostMoveState>>;
  try {
    state = await readHostMoveState(host, { oldDir: options.dir, newDir: hostMoveNewDir(options.dir) });
  } catch (error) {
    host.log('error', 'The recorded host move cannot be read; see the operations guide (host move)', {
      error: error instanceof Error ? error.message : String(error),
    });
    await host.finish();
    return 4;
  }
  if (state && TERMINAL_HOST_MOVE_PHASES.includes(state.phase) && !(options.retry && state.phase === 'rolled_back')) {
    host.log('info', 'The host move has ended', { phase: state.phase, error: state.error });
    await host.finish();
    return state.phase === 'done' ? 0 : state.phase === 'rolled_back' ? 3 : 4;
  }
  if (!state || TERMINAL_HOST_MOVE_PHASES.includes(state.phase)) {
    try {
      state = await planHostMove(host, options);
    } catch (error) {
      host.log('error', 'Could not plan the move to the Opfield layout; nothing was changed', {
        error: error instanceof Error ? error.message : String(error),
      });
      await host.finish();
      return 2;
    }
    if (!state) {
      host.log('info', 'The installation has the Opfield layout already');
      await host.finish();
      return 0;
    }
  }
  const phase = await runHostMove(host, state);
  return phase === 'done' ? 0 : phase === 'rolled_back' ? 3 : 4;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    // Docker restarts the container; the next run resumes the recorded step.
    console.error(
      JSON.stringify({
        time: new Date().toISOString(),
        level: 'error',
        message: 'The host move stopped; it resumes when the container restarts',
        error: error instanceof Error ? error.message : String(error),
      })
    );
    process.exit(1);
  }
);
