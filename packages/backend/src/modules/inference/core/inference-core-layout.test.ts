import { describe, expect, it } from 'vitest';
import { inferenceCoreLayout } from './inference-core-layout.js';

describe('inference core layout', () => {
  it('names a new core after the Compose project', () => {
    expect(inferenceCoreLayout('opfield', 'opfield_default', 'app', null)).toEqual({
      project: 'opfield',
      network: 'opfield_default',
      opfieldAlias: 'app',
      containerName: 'opfield-inference',
      stateVolume: 'opfield-inference-state',
      secretVolume: 'opfield-inference-secrets',
    });
  });

  it('keeps the names and label project of a core installed before 2.12.1 after the host move', () => {
    const layout = inferenceCoreLayout('opfield', 'opfield_default', 'app', {
      containerName: 'gateway-inference-core',
      stateVolumeName: 'gateway-inference-core-state',
      secretVolumeName: 'gateway-inference-core-secrets',
    });
    expect(layout).toEqual({
      project: 'gateway',
      network: 'opfield_default',
      opfieldAlias: 'app',
      containerName: 'gateway-inference-core',
      stateVolume: 'gateway-inference-core-state',
      secretVolume: 'gateway-inference-core-secrets',
    });
  });

  it('keeps the volumes of an install that stopped before its container was created', () => {
    const layout = inferenceCoreLayout('opfield', 'opfield_default', 'app', {
      containerName: null,
      stateVolumeName: 'opfield-inference-state',
      secretVolumeName: 'opfield-inference-secrets',
    });
    expect(layout).toMatchObject({ project: 'opfield', containerName: 'opfield-inference' });
  });
});
