import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AvailabilityMemberConfig } from '@/grpc/generated/types.js';
import { availabilityMemberConfigError } from './availability-member-config.rules.js';

const vectorsPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../proto/testdata/availability-member-config-v1.json'
);
const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8')) as {
  cases: Array<{ name: string; config: AvailabilityMemberConfig; error: string | null }>;
};

describe('availability member configuration rules (proto/testdata/availability-member-config-v1.json)', () => {
  it.each(vectors.cases.map((vector) => [vector.name, vector] as const))('%s', (_name, vector) => {
    const error = availabilityMemberConfigError(vector.config);
    if (vector.error === null) expect(error).toBeNull();
    else expect(error).toContain(vector.error);
  });
});
