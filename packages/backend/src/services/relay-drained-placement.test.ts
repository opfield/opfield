import { describe, expect, it } from 'vitest';
import { onlyDrainedRelaysLeave, parkedDrainedAssignmentIds } from './relay-topology.js';

/**
 * Stand 2.12 R-5: draining or resuming a relay that carried none of the streams re-pathed every live stream once,
 * because the drain placed every workload on a new generation without the relay and the resume on another one with it.
 * A drained relay now stays in the active generation, draining there.
 */
describe('A drained relay stays in its active generations (stand 2.12 R-5)', () => {
  const active = [
    { relayInstanceId: 'relay-local', role: 'primary' },
    { relayInstanceId: 'relay-uk', role: 'fallback' },
    { relayInstanceId: 'relay-nl', role: 'fallback' },
  ];
  const instances = [
    { id: 'relay-local', state: 'ready' },
    { id: 'relay-uk', state: 'ready' },
    { id: 'relay-nl', state: 'draining' },
  ];
  const planned = (...entries: Array<[string, 'primary' | 'fallback']>) =>
    entries.map(([id, role]) => ({ instance: { id }, role }));

  it('keeps the generation when only the drained relay leaves and the others keep their roles', () => {
    expect(
      onlyDrainedRelaysLeave(active, planned(['relay-local', 'primary'], ['relay-uk', 'fallback']), instances)
    ).toBe(true);
  });

  it('places the workload anew when a relay comes in, a role changes or a relay that does not drain leaves', () => {
    // The drained relay is replaced by another one.
    expect(
      onlyDrainedRelaysLeave(
        active,
        planned(['relay-local', 'primary'], ['relay-uk', 'fallback'], ['relay-de', 'fallback']),
        instances
      )
    ).toBe(false);
    // The near relay becomes the primary.
    expect(
      onlyDrainedRelaysLeave(active, planned(['relay-local', 'fallback'], ['relay-uk', 'primary']), instances)
    ).toBe(false);
    // A relay leaves that does not drain (it failed, or the spread shrank).
    expect(
      onlyDrainedRelaysLeave(active, planned(['relay-local', 'primary']), [
        ...instances.slice(0, 1),
        { id: 'relay-uk', state: 'offline' },
        instances[2]!,
      ])
    ).toBe(false);
    // Nothing leaves: the plan is the generation (samePlannedAssignments decides that).
    expect(
      onlyDrainedRelaysLeave(
        active,
        planned(['relay-local', 'primary'], ['relay-uk', 'fallback'], ['relay-nl', 'fallback']),
        instances
      )
    ).toBe(false);
    expect(onlyDrainedRelaysLeave(active, [], instances)).toBe(false);
  });

  it('lets a drained relay go with its assignments next to other relays in active generations', () => {
    const generations = [
      { id: 'gen-shared', state: 'active' },
      { id: 'gen-alone', state: 'active' },
      { id: 'gen-old', state: 'draining' },
    ];
    const assignments = [
      { id: 'a-local', assignmentGenerationId: 'gen-shared', relayInstanceId: 'relay-local' },
      { id: 'a-nl', assignmentGenerationId: 'gen-shared', relayInstanceId: 'relay-nl' },
      { id: 'a-nl-alone', assignmentGenerationId: 'gen-alone', relayInstanceId: 'relay-nl' },
      { id: 'a-uk-old', assignmentGenerationId: 'gen-old', relayInstanceId: 'relay-uk' },
      { id: 'a-nl-old', assignmentGenerationId: 'gen-old', relayInstanceId: 'relay-nl' },
    ];
    expect([...parkedDrainedAssignmentIds({ id: 'relay-nl', state: 'draining' }, assignments, generations)]).toEqual([
      'a-nl',
    ]);
    // A relay that does not drain keeps every assignment it has.
    expect(parkedDrainedAssignmentIds({ id: 'relay-nl', state: 'ready' }, assignments, generations).size).toBe(0);
  });
});
