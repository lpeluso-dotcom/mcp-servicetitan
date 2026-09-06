import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { list_recurring_service_events } from '../memberships/list_recurring_service_events';
import { mark_recurring_service_event } from '../memberships/mark_recurring_service_event';
import { update_recurring_service } from '../memberships/update_recurring_service';
import { toolsForRole } from '../index';
import { WriteGate } from '../../write-gate';

const ctx = { actor: 'test', correlation: 'test-correlation' };
function env() {
  return { ST_TENANT_ID: '123', MCP_SYNC_KEY: 'test', ST_PROXY: { fetch: vi.fn() } } as any;
}

describe('recurring service event tools (QUA-1452)', () => {
  it('preserves supported filters and upstream pagination while filtering membership on this page', async () => {
    const e = env();
    e.ST_PROXY.fetch.mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 1, membershipId: 8 }, { id: 2, membershipId: 9 }], page: 2, hasMore: true, totalCount: 30,
    })));
    const result = await list_recurring_service_events.handler(e, {
      membershipId: 8, locationId: 42, status: 'Dismissed', page: 2,
      modifiedOnOrAfter: '2026-09-01T00:00:00Z', modifiedBefore: '2026-09-02T00:00:00Z',
    }, ctx) as any;
    const endpoint = new URL(e.ST_PROXY.fetch.mock.calls[0][0]).searchParams.get('endpoint')!;
    const q = new URL(endpoint, 'https://example.test').searchParams;
    expect(q.get('locationId')).toBe('42');
    expect(q.get('status')).toBe('Dismissed');
    expect(q.get('modifiedOnOrAfter')).toBe('2026-09-01T00:00:00Z');
    expect(q.get('modifiedBefore')).toBe('2026-09-02T00:00:00Z');
    expect(q.has('membershipId')).toBe(false);
    expect(result.events).toEqual([{ id: 1, membershipId: 8 }]);
    expect(result.hasMore).toBe(true);
    expect(result.page).toBe(2);
    expect(result.upstreamTotalCount).toBe(30);
  });

  it.each(['complete', 'incomplete'] as const)('previews %s with required job ID and no upstream write', async direction => {
    const preview = vi.spyOn(WriteGate.prototype, 'dryRun').mockResolvedValue({ dryRun: true } as any);
    try {
      const e = env();
      await mark_recurring_service_event.handler(e, { eventId: 11, jobId: 22, direction }, ctx);
      expect(preview).toHaveBeenCalledWith('mark_recurring_service_event',
        { eventId: 11, jobId: 22, direction }, 'test', 'test-correlation', { jobId: 22 },
        `/memberships/v2/tenant/123/recurring-service-events/11/mark-${direction}`, 'POST', undefined);
      expect(e.ST_PROXY.fetch).not.toHaveBeenCalled();
    } finally { preview.mockRestore(); }
  });

  it('requires a job ID and rejects arbitrary status values', () => {
    expect(mark_recurring_service_event.annotations?.destructiveHint).toBe(true);
    const schema = z.object(mark_recurring_service_event.zodSchema);
    expect(schema.safeParse({ eventId: 1, direction: 'complete' }).success).toBe(false);
    expect(schema.safeParse({ eventId: 1, jobId: 2, direction: 'dismiss' }).success).toBe(false);
  });

  it('rejects confirmed writes without a token before contacting the proxy', async () => {
    const e = env();
    await expect(mark_recurring_service_event.handler(e,
      { eventId: 1, jobId: 2, direction: 'complete', dryRun: false }, ctx)).rejects.toMatchObject({ code: 'validation_error' });
    expect(e.ST_PROXY.fetch).not.toHaveBeenCalled();
  });

  it('rejects empty patches and invented next-date/frequency fields', () => {
    const schema = z.object(update_recurring_service.zodSchema);
    for (const patch of [{}, { nextDate: '2026-10-01' }, { frequency: 'Monthly' }]) {
      expect(schema.safeParse({ recurringServiceId: 1, patch }).success).toBe(false);
    }
    expect(schema.safeParse({ recurringServiceId: 1, patch: { recurrenceType: 'Monthly', recurrenceInterval: 3 } }).success).toBe(true);
  });

  it('previews only the supported recurrence patch', async () => {
    const preview = vi.spyOn(WriteGate.prototype, 'dryRun').mockResolvedValue({ dryRun: true } as any);
    try {
      const e = env(); const patch = { recurrenceType: 'Monthly' as const, recurrenceInterval: 3 };
      await update_recurring_service.handler(e, { recurringServiceId: 7, patch }, ctx);
      expect(preview).toHaveBeenCalledWith('update_recurring_service', { recurringServiceId: 7, patch },
        'test', 'test-correlation', patch, '/memberships/v2/tenant/123/recurring-services/7', 'PATCH', undefined);
      expect(e.ST_PROXY.fetch).not.toHaveBeenCalled();
    } finally { preview.mockRestore(); }
  });

  it('gates mutations from readonly and lockdown, while preserving the list tool', () => {
    for (const role of ['readonly', 'lockdown'] as const) {
      const names = toolsForRole(role).map(t => t.name);
      expect(names).toContain('list_recurring_service_events');
      expect(names).not.toContain('mark_recurring_service_event');
      expect(names).not.toContain('update_recurring_service');
    }
    expect(toolsForRole('default').map(t => t.name)).toContain('mark_recurring_service_event');
  });
});
