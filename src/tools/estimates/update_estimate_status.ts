// status=Sold requires soldBy technicianId — ST rejects without it.
// H1: migrated to defineWriteTool factory 2026-04-26 using validate hook for the cross-field rule.
import { z } from 'zod';
import { defineWriteTool } from '../../write-tool-factory';

const EstimateStatus = z.enum(['Open', 'Presented', 'Sold', 'Dismissed', 'Expired']);

interface Args {
  estimateId: number;
  status: z.infer<typeof EstimateStatus>;
  soldBy?: number;
  dryRun?: boolean;
  confirmation_token?: string;
}

export const update_estimate_status = defineWriteTool<Args>({
  name: 'update_estimate_status',
  description: 'Update the status of an estimate (Open → Presented → Sold|Dismissed|Expired). status=Sold requires soldBy technicianId (ST rejects without it). dryRun=true (default) → token → dryRun=false to write.',
  zodSchema: {
    estimateId: z.number().int().positive(),
    status: EstimateStatus,
    soldBy: z.number().int().positive().optional(),
  },
  validate: (args) => {
    if (args.status === 'Sold' && args.soldBy === undefined) {
      throw new Error('soldBy technicianId is required when status=Sold');
    }
  },
  endpoint: ({ estimateId }) => `/sales/v2/tenant/431848990/estimates/${estimateId}`,
  method: 'PATCH',
  payload: ({ status, soldBy }) => {
    const body: Record<string, unknown> = { status };
    if (soldBy !== undefined) body.soldBy = soldBy;
    return body;
  },
  businessArgs: ({ estimateId, status, soldBy }) => ({ estimateId, status, soldBy }),
});
