// Path must be /taskmanagement/ (no hyphen) — ST 404s on /task-management/.
// H1: migrated to defineWriteTool factory 2026-04-26.
import { z } from 'zod';
import { defineWriteTool } from '../../write-tool-factory';

interface Args {
  name: string;
  jobId: number;
  dueDate?: string;
  assignedToId?: number;
  dryRun?: boolean;
  confirmation_token?: string;
}

export const create_task = defineWriteTool<Args>({
  name: 'create_task',
  description: 'Create a task linked to a job. Path: /taskmanagement/ (no hyphen — ST 404s on /task-management/). dryRun=true (default) → token → dryRun=false to write.',
  zodSchema: {
    name: z.string().min(1).describe('Task name/description'),
    jobId: z.number().int().positive().describe('ST job ID to link the task to'),
    dueDate: z.string().optional().describe('Due date (ISO 8601 date string)'),
    assignedToId: z.number().int().positive().optional().describe('Employee ID to assign the task to'),
  },
  endpoint: () => `/taskmanagement/v2/tenant/431848990/tasks`,
  method: 'POST',
  payload: ({ name, jobId, dueDate, assignedToId }) => {
    const body: Record<string, unknown> = { name, jobId };
    if (dueDate) body.dueDate = dueDate;
    if (assignedToId) body.assignedToId = assignedToId;
    return body;
  },
  businessArgs: ({ name, jobId, dueDate, assignedToId }) => ({ name, jobId, dueDate, assignedToId }),
});
