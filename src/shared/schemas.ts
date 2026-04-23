// ============================================================
// shared/schemas.ts — Reusable Zod fragments for ST tool inputs.
// ============================================================

import { z } from 'zod';

export const zCustomerId = z.number().int().positive().describe('ST customer ID');
export const zJobId = z.number().int().positive().describe('ST job ID');
export const zAppointmentId = z.number().int().positive().describe('ST appointment ID');
export const zTechnicianId = z.number().int().positive().describe('ST technician ID');
export const zLocationId = z.number().int().positive().describe('ST location ID');
export const zBusinessUnitId = z.number().int().positive().describe('ST business unit ID');
export const zJobTypeId = z.number().int().positive().describe('ST job type ID');
export const zCampaignId = z.number().int().positive().describe('ST campaign ID');

export const zDateRange = {
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Start date YYYY-MM-DD'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('End date YYYY-MM-DD'),
};

export const zIsoDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?/).describe('ISO 8601 datetime');

export const zPage = z.number().int().positive().optional().describe('Page number, default 1');
export const zPageSize = z.number().int().positive().max(200).optional().describe('Page size, max 200');

// Standard dryRun gate fields — appended to write tool schemas.
export const zDryRunFields = {
  dryRun: z.boolean().default(true).describe('true (default) = preview + token; false = execute write'),
  confirmation_token: z.string().optional().describe('Token from prior dryRun=true call, required when dryRun=false'),
};

// Source annotation added to every tool result for read-routing transparency.
export interface SourceAnnotation {
  _source: 'd1' | 'live';
  _stale_days?: number;
  _fallback_reason?: string;
}
