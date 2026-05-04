// H1: migrated to defineWriteTool factory 2026-04-26.
import { z } from 'zod';
import { defineWriteTool } from '../../write-tool-factory';

interface Args {
  jobId: number;
  note: string;
  dryRun?: boolean;
  confirmation_token?: string;
}

export const add_job_note = defineWriteTool<Args>({
  name: 'add_job_note',
  description: 'Append a note to a job. ST notes are append-only. dryRun=true (default) → token → dryRun=false to write.',
  zodSchema: {
    jobId: z.number().int().positive().describe('ST job ID'),
    note: z.string().min(1).describe('Note text to append'),
  },
  endpoint: ({ jobId }) => `/jpm/v2/tenant/000000000/jobs/${jobId}/notes`,
  method: 'POST',
  payload: ({ note }) => ({ note }),
  businessArgs: ({ jobId, note }) => ({ jobId, note }),
  stEndpointTemplate: '/jpm/v2/tenant/{tid}/jobs/{jobId}/notes',
});
