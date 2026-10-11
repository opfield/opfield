import { describe, expect, it } from 'vitest';
import { recreateQueuedAnswer } from './ai.docker-container-tools.js';

/** An agent must not report a recreate as done when the node only queued it. */
describe('MCP container recreate answer', () => {
  it('reports the recreate as queued with the task to follow', () => {
    const answer = recreateQueuedAnswer({ taskId: 'task-1', containerId: 'web', name: 'web', type: 'recreate' });
    expect(answer).toMatchObject({ success: true, status: 'queued', taskId: 'task-1' });
    expect(answer.message).toContain('queued on the node as task task-1; it has not finished yet');
    expect(answer.message).toContain('manage_app_variables workload_task');
  });

  it('reports a rollout through an availability policy as queued as well', () => {
    expect(recreateQueuedAnswer({ availabilityManaged: true })).toMatchObject({
      status: 'queued',
      message: 'Container recreate queued as a rollout of its availability policy; it has not finished yet',
    });
  });

  it('says queued without a task id when the answer has none', () => {
    expect(recreateQueuedAnswer(null)).toMatchObject({ status: 'queued', taskId: null });
  });
});
