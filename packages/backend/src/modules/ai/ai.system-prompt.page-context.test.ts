import { describe, expect, it } from 'vitest';
import { pageContextPromptParts } from './ai.system-prompt.js';

const text = (parts: Array<{ content: string }>) => parts.map((part) => part.content).join('\n');

describe('page context in the system prompt', () => {
  it('names the focused resource on a detail page', () => {
    const prompt = text(
      pageContextPromptParts({
        route: '/apps/shop/overview',
        resourceType: 'app',
        resourceId: '3f1c2d4e-0000-4000-8000-000000000001',
        label: 'Shop',
      })
    );
    expect(prompt).toContain('The user is currently viewing: /apps/shop/overview');
    expect(prompt).toContain('Focused resource: app with ID 3f1c2d4e-0000-4000-8000-000000000001, label Shop');
  });

  it('keeps dots in ids such as Docker volume names', () => {
    const prompt = text(
      pageContextPromptParts({
        route: '/docker/volumes/node-a/data.v2',
        resourceType: 'docker-volume',
        resourceId: 'data.v2',
        nodeId: 'node-1',
      })
    );
    expect(prompt).toContain('Focused resource: docker-volume with ID data.v2, node ID node-1');
  });

  it('names the page on list and settings pages', () => {
    const prompt = text(pageContextPromptParts({ route: '/databases', label: 'Databases' }));
    expect(prompt).toContain('The user is currently viewing: /databases');
    expect(prompt).toContain('Page: Databases');
    expect(prompt).not.toContain('Focused resource');
  });

  it('adds nothing when the user left the page out of the request', () => {
    expect(pageContextPromptParts({ route: '' })).toEqual([]);
    expect(pageContextPromptParts(undefined)).toEqual([]);
  });
});
