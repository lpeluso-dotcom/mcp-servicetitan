// Path must be /taskmanagement/ (no hyphen) — ST 404s on /task-management/.
// H1: migrated to defineWriteTool factory 2026-04-26.
// v1.5: expanded schema to the 8 ST-required fields. The previous 4-field
// shape returned 200 OK but created an incomplete task missing assignment +
// reporter + classification — caught in production when an automated caller
// produced tasks with no reportedBy / no businessUnitId.
import { z } from 'zod';
import { defineWriteTool } from '../../write-tool-factory';

interface Args {
  // v1 fields (still accepted)
  name: string;
  jobId: number;
  dueDate?: string;
  assignedToId?: number;
  // v1.5 ST-required fields
  body: string;
  reportedById: number;
  businessUnitId: number;
  employeeTaskTypeId: number;
  employeeTaskSourceId: number;
  reportedDate?: string;
  isClosed?: boolean;
  priority?: 'Normal' | 'High' | 'Urgent';
  // factory adds dryRun + confirmation_token
  dryRun?: boolean;
  confirmation_token?: string;
}

export const create_task = defineWriteTool<Args>({
  name: 'create_task',
  description:
    'Create a task linked to a job. Path: /taskmanagement/ (no hyphen — ST 404s on /task-management/). ' +
    "v1.5: payload now includes the 8 ST-required fields (name/jobId/body/reportedById/businessUnitId/" +
    "employeeTaskTypeId/employeeTaskSourceId + reportedDate/isClosed/priority defaults). " +
    'dryRun=true (default) → token → dryRun=false to write.',
  zodSchema: {
    name: z.string().min(1).describe('Task name/headline'),
    jobId: z.number().int().positive().describe('ST job ID to link the task to'),
    body: z.string().min(1).describe('Task body / detailed description (required by ST)'),
    reportedById: z
      .number()
      .int()
      .positive()
      .describe('Employee ID that reported/created the task (required by ST)'),
    businessUnitId: z
      .number()
      .int()
      .positive()
      .describe('Business Unit ID for routing/visibility (required by ST)'),
    employeeTaskTypeId: z
      .number()
      .int()
      .positive()
      .describe('Task type ID from /taskmanagement/v2/.../task-types (required by ST)'),
    employeeTaskSourceId: z
      .number()
      .int()
      .positive()
      .describe('Task source ID from /taskmanagement/v2/.../task-sources (required by ST)'),
    reportedDate: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp; defaults to now if omitted'),
    isClosed: z
      .boolean()
      .optional()
      .describe('Open/closed state on creation; defaults to false'),
    priority: z
      .enum(['Normal', 'High', 'Urgent'])
      .optional()
      .describe('Task priority (ST enum); defaults to Normal'),
    dueDate: z.string().optional().describe('Due date (ISO 8601 date string)'),
    assignedToId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Employee ID to assign the task to'),
  },
  endpoint: () => `/taskmanagement/v2/tenant/000000000/tasks`,
  method: 'POST',
  payload: ({
    name,
    jobId,
    body,
    reportedById,
    businessUnitId,
    employeeTaskTypeId,
    employeeTaskSourceId,
    reportedDate,
    isClosed,
    priority,
    dueDate,
    assignedToId,
  }) => {
    const out: Record<string, unknown> = {
      name,
      jobId,
      body,
      reportedById,
      businessUnitId,
      employeeTaskTypeId,
      employeeTaskSourceId,
      reportedDate: reportedDate ?? new Date().toISOString(),
      isClosed: isClosed ?? false,
      priority: priority ?? 'Normal',
    };
    if (dueDate) out.dueDate = dueDate;
    if (assignedToId) out.assignedToId = assignedToId;
    return out;
  },
  stEndpointTemplate: '/taskmanagement/v2/tenant/{tid}/tasks',
});
