import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import { defaultShaper } from '../../response-shape';
import type { ToolDef } from '../index';

export const payroll_settings_get: ToolDef<Record<string, never>> = {
  name: 'payroll_settings_get',
  description:
    'Get the tenant payroll configuration (pay period, overtime rules, etc.). Source: live ST.',
  zodSchema: {},
  async handler(env, _args, { actor, correlation }) {
    const path = `/payroll/v2/tenant/${env.ST_TENANT_ID}/payroll-settings`;
    const resp = await env.ST_PROXY.fetch(
      `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(path)}`,
      { headers: authHeaders(env, correlation, actor) },
    );
    if (!resp.ok) {
      throw new McpError('upstream_error', `payroll_settings_get failed: ${resp.status} ${path}`, {
        correlation,
      });
    }
    return { ...((await resp.json()) as Record<string, unknown>), _source: 'live' };
  },
  transformResult: defaultShaper,
};
