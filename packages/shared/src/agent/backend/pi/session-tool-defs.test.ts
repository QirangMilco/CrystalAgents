import { describe, expect, it } from 'bun:test';
import { getSessionToolProxyDefs } from './session-tool-defs.ts';

describe('Pi session tool proxy defs', () => {
  it('relaxes rich metadata requirements for Pi-facing schema', () => {
    const defs = getSessionToolProxyDefs();
    const submitPlan = defs.find(def => def.name === 'mcp__session__SubmitPlan');

    expect(submitPlan).toBeDefined();
    expect(submitPlan?.inputSchema).toMatchObject({
      properties: {
        _displayName: expect.objectContaining({ type: 'string' }),
        _intent: expect.objectContaining({ type: 'string' }),
        displayName: expect.objectContaining({ type: 'string' }),
        intent: expect.objectContaining({ type: 'string' }),
        intention: expect.objectContaining({ type: 'string' }),
      },
    });

    expect(submitPlan?.inputSchema.required).not.toContain('_displayName');
    expect(submitPlan?.inputSchema.required).not.toContain('_intent');
    expect(submitPlan?.inputSchema.required).toContain('planPath');
  });
});
