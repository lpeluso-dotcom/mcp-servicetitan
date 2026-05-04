// ST rejects with 400 if the membership is not Active.
// H1: migrated to defineWriteTool factory 2026-04-26.
import { z } from 'zod';
import { defineWriteTool } from '../../write-tool-factory';

interface Args {
  membershipId: number;
  serviceTypeId: number;
  locationId: number;
  dryRun?: boolean;
  confirmation_token?: string;
}

export const create_recurring_service = defineWriteTool<Args>({
  name: 'create_recurring_service',
  description: 'Create a recurring service under an active membership. ST requires the membership to be Active (returns 400 otherwise). dryRun=true (default) → token → dryRun=false to write.',
  zodSchema: {
    membershipId: z.number().int().positive().describe('ST membership ID (must be Active status)'),
    serviceTypeId: z.number().int().positive().describe('ST service type ID for the recurring service'),
    locationId: z.number().int().positive().describe('ST location ID where the service will be performed'),
  },
  endpoint: ({ serviceTypeId }) => `/memberships/v2/tenant/000000000/recurring-service-types/${serviceTypeId}/recurring-services`,
  method: 'POST',
  payload: ({ membershipId, serviceTypeId, locationId }) => ({ membershipId, serviceTypeId, locationId }),
  businessArgs: ({ membershipId, serviceTypeId, locationId }) => ({ membershipId, serviceTypeId, locationId }),
  stEndpointTemplate: '/memberships/v2/tenant/{tid}/recurring-service-types/{serviceTypeId}/recurring-services',
});
