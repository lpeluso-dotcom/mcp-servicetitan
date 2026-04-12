// ============================================================
// tools/index.ts — Tool registry
// ============================================================

import type { Env } from '../env';
import { st_list_customers } from './st_list_customers';
import { st_get_customer } from './st_get_customer';
import { st_list_jobs } from './st_list_jobs';
import { st_list_appointments } from './st_list_appointments';
import { st_get_pricebook } from './st_get_pricebook';
import { siro_list_mobile_events } from './siro_list_mobile_events';
import { siro_get_recording_summary } from './siro_get_recording_summary';
import { siro_get_engagement } from './siro_get_engagement';

export interface ToolContext {
  actor: string;
  correlation: string;
}

export interface ToolDef<Args = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (env: Env, args: Args, ctx: ToolContext) => Promise<unknown>;
}

// Register all tools here. Order controls tools/list output order.
// ServiceTitan tools first, then Siro (ST acquired Siro).
export const TOOLS: readonly ToolDef<any>[] = [
  st_list_customers,
  st_get_customer,
  st_list_jobs,
  st_list_appointments,
  st_get_pricebook,
  siro_list_mobile_events,
  siro_get_recording_summary,
  siro_get_engagement,
] as const;

export function findTool(name: string): ToolDef<any> | undefined {
  return TOOLS.find((t) => t.name === name);
}

export function toolSchemas() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}
