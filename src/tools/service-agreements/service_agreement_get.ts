import { z } from 'zod';
import { readST } from '../../st-read';
import type { ToolDef } from '../index';

const TENANT_ID = '000000000';

interface Args {
  serviceAgreementId: number;
}

export const service_agreement_get: ToolDef<Args> = {
  name: 'service_agreement_get',
  description:
    'Get one ServiceTitan service agreement by ID. ST-77 adds BillingScheduleType=Custom; ST-77.1 adds customFields on responses. Source: live ST.',
  zodSchema: {
    serviceAgreementId: z.number().int().positive().describe('ST service agreement ID'),
  },
  stEndpoint: {
    method: 'GET',
    path: '/service-agreements/v2/tenant/{tid}/service-agreements/{serviceAgreementId}',
    source: 'live',
  },
  async handler(env, args, { actor, correlation }) {
    const serviceAgreement = await readST(
      env,
      `/service-agreements/v2/tenant/${TENANT_ID}/service-agreements/${args.serviceAgreementId}`,
      { actor, correlation }
    );
    return { service_agreement: serviceAgreement, _source: 'live' };
  },
};
