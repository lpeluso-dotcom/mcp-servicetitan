// ============================================================
// siro_shaper.test.ts — QUA-783
//
// Real Siro payloads captured 2026-07-11 from the 3 siro_* tool
// endpoints. Proves defaultShaper preserves every load-bearing Siro
// field. The sweep review's finding I-3 feared a HAL-style
// `_links.*.href` media pointer would be stripped; verified here that
// Siro exposes none of the 5 stripped keys on these 3 tools, and the
// recording pointer (`recordingId`, a plain scalar) survives.
// ============================================================
import { describe, it, expect } from 'vitest';
import { siro_list_mobile_events } from '../siro_list_mobile_events';
import { siro_get_recording_summary } from '../siro_get_recording_summary';
import { siro_get_engagement } from '../siro_get_engagement';

const STRIPPED = ['paginationToken', 'requestId', 'eTag', '_links', '_meta'] as const;

function keysAnywhere(v: unknown, acc = new Set<string>()): Set<string> {
  if (Array.isArray(v)) {
    for (const item of v) keysAnywhere(item, acc);
  } else if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      acc.add(k);
      keysAnywhere(val, acc);
    }
  }
  return acc;
}

// --- /v1/core/mobile-events (verbatim real rows) ---
const MOBILE_EVENTS = {
  data: [
    {
      id: '86f3256c-1b0f-4434-b8a5-0d8ee4c2c840',
      recordingId: null,
      userId: 'hvp84DlKcNS1L2cO8O4tYnaT0rB2',
      organizationId: '7e5fbcad-1839-4dcb-b13f-4659468c64a6',
      createdAt: '2026-07-11T13:17:43.676Z',
      eventCode: 'appStateChange',
      event: { value: 'background' },
    },
    {
      id: 'fbfa2212-12cb-4293-affb-bb784343c1bc',
      recordingId: '6778f6ca-31cc-4412-acce-57dd223f5d20-hvp84DlKcNS1L2cO8O4tYnaT0rB2',
      userId: 'hvp84DlKcNS1L2cO8O4tYnaT0rB2',
      organizationId: '7e5fbcad-1839-4dcb-b13f-4659468c64a6',
      createdAt: '2026-07-11T13:17:43.659Z',
      eventCode: 'appStateChange',
      event: { value: 'background' },
      externalOpportunityIds: ['83174924'],
    },
  ],
  cursor: 'MjAyNi0wNy0xMVQxMzoxNzo0My42MDda',
};

// --- /v1/core/recordings/{id}/summaries (verbatim real row) ---
const SUMMARY = {
  data: [
    {
      id: '01c92684-1d96-4dbc-a7d5-5674048ba9ac',
      name: 'Outcome & Next Steps',
      content:
        'The transcript is too incomplete to determine any secured commitment, any materials left with the customer, or any promised follow-up.',
    },
  ],
};

// --- /v1/integrations/engagements/{id} (verbatim real subset) ---
const ENGAGEMENT = {
  id: '07d7dd48-2247-449d-b810-5dda42da4e34',
  externalId: 'e547fed4-4afb-4dcb-b097-cfc0ee9f8d7d',
  subject: 'Clemson Pee Dee Rec , Job # 82023266',
  content: null,
  opportunityId: 'accb4ac5-3422-4548-9d9a-9beb34d90cd3',
  accountId: '264203_269264',
  organizationId: '7e5fbcad-1839-4dcb-b13f-4659468c64a6',
  engagementType: 'SIRO_EVENT',
  recordingId: 'f3ce377b-d880-4d91-932e-46c5d4f527de-VHEkqKZjJxMKLJBXlIGzY28ThYc2',
  engagementUsers: [
    { id: 'ba003ab9-5c8c-4b25-946a-492ad254fb99', userId: '93714fbf-cba0-4569-a188-6a6e7f551f77', externalId: '5522937' },
  ],
};

describe('siro_list_mobile_events — defaultShaper preserves fields', () => {
  it('keeps the cursor and every row recordingId/eventCode', () => {
    const shaped = siro_list_mobile_events.transformResult!(MOBILE_EVENTS) as typeof MOBILE_EVENTS;
    expect(shaped.cursor).toBe('MjAyNi0wNy0xMVQxMzoxNzo0My42MDda');
    expect(shaped.data).toHaveLength(2);
    expect(shaped.data[0]).toHaveProperty('recordingId');
    expect(shaped.data[1].recordingId).toBe(
      '6778f6ca-31cc-4412-acce-57dd223f5d20-hvp84DlKcNS1L2cO8O4tYnaT0rB2',
    );
    expect(shaped.data[1].externalOpportunityIds).toEqual(['83174924']);
    const allKeys = [...keysAnywhere(shaped)];
    for (const k of STRIPPED) expect(allKeys).not.toContain(k);
  });
});

describe('siro_get_recording_summary — defaultShaper preserves fields', () => {
  it('keeps data[].{id,name,content}', () => {
    const shaped = siro_get_recording_summary.transformResult!(SUMMARY) as typeof SUMMARY;
    expect(shaped.data[0].id).toBe('01c92684-1d96-4dbc-a7d5-5674048ba9ac');
    expect(shaped.data[0].name).toBe('Outcome & Next Steps');
    expect(shaped.data[0].content).toContain('too incomplete');
    const allKeys = [...keysAnywhere(shaped)];
    for (const k of STRIPPED) expect(allKeys).not.toContain(k);
  });
});

describe('siro_get_engagement — defaultShaper preserves fields', () => {
  it('keeps recordingId/opportunityId/subject/accountId', () => {
    const shaped = siro_get_engagement.transformResult!(ENGAGEMENT) as typeof ENGAGEMENT;
    expect(shaped.recordingId).toBe(
      'f3ce377b-d880-4d91-932e-46c5d4f527de-VHEkqKZjJxMKLJBXlIGzY28ThYc2',
    );
    expect(shaped.opportunityId).toBe('accb4ac5-3422-4548-9d9a-9beb34d90cd3');
    expect(shaped.subject).toBe('Clemson Pee Dee Rec , Job # 82023266');
    expect(shaped.accountId).toBe('264203_269264');
    expect(shaped.engagementUsers[0].userId).toBe('93714fbf-cba0-4569-a188-6a6e7f551f77');
    const allKeys = [...keysAnywhere(shaped)];
    for (const k of STRIPPED) expect(allKeys).not.toContain(k);
  });
});
