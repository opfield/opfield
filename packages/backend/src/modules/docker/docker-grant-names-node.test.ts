import { describe, expect, it } from 'vitest';
import { dockerGrantNamesNode } from './docker-access-resource.service.js';

const NODE = '6dd00f76-629a-429b-a242-68bfa82d0f7f';
const OTHER = '1ffe8c9b-5033-4869-b0a3-6114517613e3';
const BASE = 'docker:compose:create';

describe('a Docker grant that names a node', () => {
  it('covers the node everywhere or by its id', () => {
    expect(dockerGrantNamesNode([BASE], BASE, NODE)).toBe(true);
    expect(dockerGrantNamesNode([`${BASE}:${NODE}`], BASE, NODE)).toBe(true);
  });

  it('does not cover a node it does not name', () => {
    expect(dockerGrantNamesNode([`${BASE}:${OTHER}`], BASE, NODE)).toBe(false);
    expect(dockerGrantNamesNode([`${BASE}:${OTHER}/project-1`], BASE, NODE)).toBe(false);
    expect(dockerGrantNamesNode(['docker:compose:view'], BASE, NODE)).toBe(false);
    expect(dockerGrantNamesNode([], BASE, NODE)).toBe(false);
  });
});
