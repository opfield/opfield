import { describe, expect, it } from 'vitest';
import { canonicalDockerReference, resolvePulledDockerImage } from './docker-internal-images.js';

const digest = `sha256:${'2d9a'.repeat(16)}`;
const otherDigest = `sha256:${'b7e1'.repeat(16)}`;

const python = { Id: 'sha256:python', RepoTags: ['python:3.13-alpine'], RepoDigests: [`python@${digest}`] };
const valkey = { Id: 'sha256:valkey', RepoTags: [], RepoDigests: [`valkey/valkey-bundle@${otherDigest}`] };
const nginx = { Id: 'sha256:nginx', RepoTags: ['nginx:latest'], RepoDigests: [] };
const mirror = {
  Id: 'sha256:mirror',
  RepoTags: ['172.20.0.138:5443/library/redis:7'],
  RepoDigests: [`172.20.0.138:5443/library/redis@${digest.replace('2d9a', 'aaaa')}`],
};

describe('canonical Docker references', () => {
  it('compares Docker Hub references in every spelling', () => {
    const canonical = { repository: 'docker.io/library/python', tag: '3.13-alpine', digest: null };
    expect(canonicalDockerReference('python:3.13-alpine')).toEqual(canonical);
    expect(canonicalDockerReference('library/python:3.13-alpine')).toEqual(canonical);
    expect(canonicalDockerReference('docker.io/library/python:3.13-alpine')).toEqual(canonical);
    expect(canonicalDockerReference('index.docker.io/library/python:3.13-alpine')).toEqual(canonical);
    expect(canonicalDockerReference('registry-1.docker.io/python:3.13-alpine')).toEqual(canonical);
    expect(canonicalDockerReference('nginx')).toEqual({
      repository: 'docker.io/library/nginx',
      tag: 'latest',
      digest: null,
    });
  });

  it('keeps other registries, ports and digests', () => {
    expect(canonicalDockerReference(`valkey/valkey-bundle:9.1@${otherDigest}`)).toEqual({
      repository: 'docker.io/valkey/valkey-bundle',
      tag: '9.1',
      digest: otherDigest,
    });
    expect(canonicalDockerReference(`172.20.0.138:5443/opfield/api@${digest}`)).toEqual({
      repository: '172.20.0.138:5443/opfield/api',
      tag: null,
      digest,
    });
    expect(canonicalDockerReference('localhost/app:dev').repository).toBe('localhost/app');
  });
});

describe('the image a pull left on the node', () => {
  const images = [python, valkey, nginx, mirror];

  it('finds an exact reference or image id', () => {
    expect(resolvePulledDockerImage(images, 'python:3.13-alpine')).toBe(python);
    expect(resolvePulledDockerImage(images, 'sha256:nginx')).toBe(nginx);
  });

  it('finds a Docker Hub image named with docker.io/library/ or a registry alias', () => {
    expect(resolvePulledDockerImage(images, 'docker.io/library/python:3.13-alpine')).toBe(python);
    expect(resolvePulledDockerImage(images, 'docker.io/python:3.13-alpine')).toBe(python);
    expect(resolvePulledDockerImage(images, 'docker.io/library/nginx')).toBe(nginx);
  });

  it('finds an image pulled by tag and digest, which Docker stores only as repo@digest', () => {
    expect(resolvePulledDockerImage(images, `python:3.13-alpine@${digest}`)).toBe(python);
    expect(resolvePulledDockerImage(images, `docker.io/valkey/valkey-bundle@${otherDigest}`)).toBe(valkey);
    expect(resolvePulledDockerImage(images, `valkey/valkey-bundle:9.1@${otherDigest}`)).toBe(valkey);
  });

  it('falls back to the digest alone when the repository was written another way', () => {
    expect(resolvePulledDockerImage(images, `mirror.example/valkey/valkey-bundle@${otherDigest}`)).toBe(valkey);
  });

  it('takes the one new image of the repository when no reference matches', () => {
    const fresh = { Id: 'sha256:fresh', RepoTags: ['python:3.13'], RepoDigests: [] };
    const unrelated = { Id: 'sha256:other', RepoTags: ['redis:8'], RepoDigests: [] };
    const before = new Set(images.map((image) => image.Id));
    expect(resolvePulledDockerImage([...images, fresh], 'python:3.13-slim', before)).toBe(fresh);
    expect(resolvePulledDockerImage([...images, unrelated], 'python:3.13-slim', before)).toBe(null);
    expect(resolvePulledDockerImage([...images, fresh], 'python:3.13-slim')).toBe(null);
  });

  it('refuses to guess between two candidates', () => {
    const twin = { Id: 'sha256:twin', RepoTags: [], RepoDigests: [`mirror.example/python@${digest}`] };
    expect(resolvePulledDockerImage([python, twin], `ghcr.io/x/python@${digest}`)).toBe(null);
    expect(resolvePulledDockerImage(images, 'busybox:1')).toBe(null);
  });
});
