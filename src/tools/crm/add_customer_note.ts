// T1 catalog correction: renamed from update_customer_note — ST API is append-only (no PATCH on notes).
// H1: migrated to defineWriteTool factory 2026-04-26 (first migration; soak before batch-migrating others).
import { z } from 'zod';
import { defineWriteTool } from '../../write-tool-factory';

interface Args {
  customerId: number;
  note: string;
  dryRun?: boolean;
  confirmation_token?: string;
}

export const add_customer_note = defineWriteTool<Args>({
  name: 'add_customer_note',
  description: 'Append a note to a customer record. ST notes are append-only — this creates a new note entry, not an update. dryRun=true (default) → token → dryRun=false to write.',
  zodSchema: {
    customerId: z.number().int().positive().describe('ST customer ID'),
    note: z.string().min(1).describe('Note text to append'),
  },
  endpoint: ({ customerId }) => `/crm/v2/tenant/000000000/customers/${customerId}/notes`,
  method: 'POST',
  payload: ({ note }) => ({ note }),
  businessArgs: ({ customerId, note }) => ({ customerId, note }),
  stEndpointTemplate: '/crm/v2/tenant/{tid}/customers/{customerId}/notes',
  invalidatesCache: () => ['servicetitan:get_customer', 'servicetitan:find_customer'],
});
