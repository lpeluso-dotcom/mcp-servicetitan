// T1/T2 catalog correction: campaignId is REQUIRED — ST rejects without it.
// H1: migrated to defineWriteTool factory 2026-04-26.
import { z } from 'zod';
import { defineWriteTool } from '../../write-tool-factory';

interface Args {
  customerId: number;
  locationId: number;
  businessUnitId: number;
  jobTypeId: number;
  campaignId: number;
  start: string;
  end: string;
  priority?: 'Normal' | 'Urgent' | 'Low';
  summary?: string;
  tagTypeIds?: number[];
  dryRun?: boolean;
  confirmation_token?: string;
}

export const book_job = defineWriteTool<Args>({
  name: 'book_job',
  description: 'Book a new ST job. campaignId is required — ST rejects jobs without it. dryRun=true (default) → token → dryRun=false to write. For projects-grouped multi-day bookings (installs/returns), see future `st_list_projects` + `attach_job_to_project` (deferred until JPM Projects D1 sync lands).',
  zodSchema: {
    customerId: z.number().int().positive().describe('ST customer ID'),
    locationId: z.number().int().positive().describe('ST location ID'),
    businessUnitId: z.number().int().positive().describe('ST business unit ID'),
    jobTypeId: z.number().int().positive().describe('ST job type ID'),
    campaignId: z.number().int().positive().describe('ST campaign ID — REQUIRED by ST API'),
    start: z.string().describe('Appointment start ISO 8601 datetime'),
    end: z.string().describe('Appointment end ISO 8601 datetime'),
    priority: z.enum(['Normal', 'Urgent', 'Low']).optional().describe('Job priority'),
    summary: z.string().optional().describe('Job summary / customer notes'),
    tagTypeIds: z.array(z.number().int().positive()).optional().describe('Tag type IDs to apply'),
  },
  endpoint: () => `/jpm/v2/tenant/000000000/jobs`,
  method: 'POST',
  payload: (args) => {
    const { dryRun: _dr, confirmation_token: _ct, ...rest } = args;
    return rest;
  },
  stEndpointTemplate: '/jpm/v2/tenant/{tid}/jobs',
});
