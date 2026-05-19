import { readST } from '../../st';
import { defaultShaper } from '../../response-shape';
import type { ToolDef } from '../index';

export const payroll_settings_get: ToolDef<Record<string, never>> = {
  name: 'payroll_settings_get',
  description:
    'Get the tenant payroll configuration (pay period, overtime rules, etc.). Source: live ST.',
  zodSchema: {},
  stEndpoint: { method: 'GET', path: '/payroll/v2/tenant/{tid}/payroll-settings', source: 'live' },
  async handler(env, _args, { actor, correlation }) {
    const path = `/payroll/v2/tenant/${env.ST_TENANT_ID}/payroll-settings`;
    const settings = await readST<Record<string, unknown>>(env, { actor, correlation }, path);
    return { ...settings, _source: 'live' };
  },
  transformResult: defaultShaper,
};
