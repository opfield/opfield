import { describe, expect, it } from 'vitest';
import { appliedLayerKeys, type ContainerLayerPlan, layerRemovals, layerValues } from './app-container-layer.js';
import { layerDigest, mergeLayerEnv } from './app-env-layer.js';

function plan(
  vars: Record<string, string>,
  secrets: Record<string, string>,
  previousKeys: string[] | null
): ContainerLayerPlan {
  return {
    ownerKey: 'node:web',
    layer: {
      environmentId: 'env',
      vars,
      secrets,
      keys: [...Object.keys(vars), ...Object.keys(secrets)].sort(),
      digest: layerDigest(vars, secrets),
    },
    previous: previousKeys ? { environmentId: 'env', appliedKeys: previousKeys, appliedDigest: 'old' } : null,
  };
}

describe('container environment layer', () => {
  it('puts environment variables under secrets and the container own env above both', () => {
    const layer = plan({ LOG_LEVEL: 'debug', REGION: 'eu' }, { API_KEY: 'layer-secret', REGION: 'secret-wins' }, null);
    const own = { LOG_LEVEL: 'trace' };
    const containerSecrets = { API_KEY: 'own-secret' };
    expect({ ...layerValues(layer), ...own, ...containerSecrets }).toEqual({
      LOG_LEVEL: 'trace',
      REGION: 'secret-wins',
      API_KEY: 'own-secret',
    });
    expect(mergeLayerEnv(layer.layer, own, null).env).toEqual({
      LOG_LEVEL: 'trace',
      REGION: 'secret-wins',
      API_KEY: 'layer-secret',
    });
  });

  it('removes keys that left the layer unless the container sets them itself', () => {
    const layer = plan({ LOG_LEVEL: 'debug' }, {}, ['LOG_LEVEL', 'OLD_FLAG', 'OWN']);
    expect(layerRemovals(layer, ['OWN'])).toEqual(['OLD_FLAG']);
    expect(appliedLayerKeys(layer)).toEqual(['LOG_LEVEL', 'OLD_FLAG', 'OWN']);
  });

  it('removes every received key once the container left its app', () => {
    const outside: ContainerLayerPlan = {
      ownerKey: 'node:web',
      layer: { environmentId: null, vars: {}, secrets: {}, keys: [], digest: layerDigest({}, {}) },
      previous: { environmentId: 'env', appliedKeys: ['LOG_LEVEL', 'API_KEY'], appliedDigest: 'old' },
    };
    expect(layerValues(outside)).toEqual({});
    expect(layerRemovals(outside, [])).toEqual(['LOG_LEVEL', 'API_KEY']);
  });

  it('changes nothing for a container that never received a layer', () => {
    expect(layerValues(null)).toEqual({});
    expect(layerRemovals(null, ['A'])).toEqual([]);
    expect(appliedLayerKeys(null)).toEqual([]);
  });

  it('gives a stable digest that changes with any key or value', () => {
    expect(layerDigest({ A: '1', B: '2' }, {})).toBe(layerDigest({ B: '2', A: '1' }, {}));
    expect(layerDigest({ A: '1' }, {})).not.toBe(layerDigest({ A: '2' }, {}));
    expect(layerDigest({ A: '1' }, {})).not.toBe(layerDigest({}, { A: '1' }));
  });
});
