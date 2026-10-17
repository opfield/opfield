import { parseArgs } from 'node:util';
import { activatePreviousCommercialRelease, installCommercialRelease } from './install.js';

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    directory: { type: 'string', default: '/var/lib/opfield/commercial' },
    'host-version': { type: 'string' },
    rollback: { type: 'boolean', default: false },
  },
});

if (!values['host-version'] || (!values.rollback && !values.source) || (values.rollback && values.source)) {
  throw new Error(
    'Usage: install-cli --host-version VERSION [--source UNPACKED_RELEASE | --rollback] [--directory PATH]'
  );
}

const options = { directory: values.directory!, hostVersion: values['host-version'] };
const result = values.rollback
  ? await activatePreviousCommercialRelease(options)
  : await installCommercialRelease({ ...options, source: values.source! });
process.stdout.write(`${JSON.stringify(result)}\n`);
