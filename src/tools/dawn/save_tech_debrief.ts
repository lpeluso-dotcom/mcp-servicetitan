// ============================================================
// save_tech_debrief — Dawn SMS support (v1.6.0)
//
// Saves a tech debrief from an SMS conversation to D1.
// Idempotent on retell_chat_id (Retell may retry).
// Always returns HTTP 200 — never throws (F8 lesson from voice era).
// Bypasses write-gate.ts (D1 write, not ST write).
// stEndpoint: undefined (D1-only, not ST-backed)
//
// F9 lesson: uses `tech_name` not `name` — `name` collides with
// Retell internal field and causes silent drop.
// ============================================================

import { z } from 'zod';
import type { ToolDef } from '../index';
import type { Env } from '../../env';

interface Args {
  retell_chat_id: string;
  tech_id: string;
  tech_name: string;
  tech_phone: string;
  job_id?: string;
  customer_name?: string;
  job_complete?: number;
  parts_used?: string;
  follow_up_type?: 'none' | 'parts_returning' | 'sales_callback' | 'other';
  follow_up_notes?: string;
  additional_notes?: string;
  transcript_summary?: string;
  status?: 'complete' | 'partial' | 'abandoned';
}

export const save_tech_debrief: ToolDef<Args> = {
  name: 'save_tech_debrief',
  description:
    'Save a tech debrief from an SMS conversation (Dawn agent). ' +
    'Idempotent on retell_chat_id — safe to call on Retell retry. ' +
    'D1-only (no ST API call). Always returns 200 — never throws.',
  zodSchema: {
    retell_chat_id: z.string().min(1).describe('Retell session ID (used for idempotency)'),
    tech_id: z.string().min(1).describe('Technician ID'),
    tech_name: z.string().min(1).describe('Technician name (use tech_name, not name — F9)'),
    tech_phone: z.string().min(1).describe('Technician phone number'),
    job_id: z.string().optional().describe('ServiceTitan job ID (if known)'),
    customer_name: z.string().optional().describe('Customer name (if known)'),
    job_complete: z
      .number()
      .int()
      .min(0)
      .max(1)
      .optional()
      .default(0)
      .describe('1 = job complete, 0 = not complete'),
    parts_used: z
      .string()
      .optional()
      .default('[]')
      .describe('JSON array of parts used (as string)'),
    follow_up_type: z
      .enum(['none', 'parts_returning', 'sales_callback', 'other'])
      .optional()
      .default('none')
      .describe('Type of follow-up needed'),
    follow_up_notes: z.string().optional().describe('Follow-up notes'),
    additional_notes: z.string().optional().describe('Additional notes from the debrief'),
    transcript_summary: z.string().optional().describe('AI-generated summary of the conversation'),
    status: z
      .enum(['complete', 'partial', 'abandoned'])
      .optional()
      .default('complete')
      .describe('Debrief completion status'),
  },
  stEndpoint: undefined,
  async handler(env: Env, args: Args) {
    // Parse-error guard — validate required fields
    if (!args.retell_chat_id || args.retell_chat_id.trim() === '') {
      return { status: 'parse_error', message: 'Missing required fields.' };
    }
    if (!args.tech_id || !args.tech_name || !args.tech_phone) {
      return { status: 'parse_error', message: 'Missing required fields.' };
    }

    const jobComplete = args.job_complete ?? 0;
    const partsUsed = args.parts_used ?? '[]';
    const followUpType = args.follow_up_type ?? 'none';
    const debriefStatus = args.status ?? 'complete';

    try {
      const result = await env.DB.prepare(
        `INSERT INTO dawn_text_debriefs
           (retell_chat_id, tech_id, tech_name, tech_phone,
            job_id, customer_name, job_complete, parts_used,
            follow_up_type, follow_up_notes, additional_notes,
            transcript_summary, status, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(retell_chat_id) DO UPDATE SET
           tech_id = excluded.tech_id,
           tech_name = excluded.tech_name,
           tech_phone = excluded.tech_phone,
           job_id = excluded.job_id,
           customer_name = excluded.customer_name,
           job_complete = excluded.job_complete,
           parts_used = excluded.parts_used,
           follow_up_type = excluded.follow_up_type,
           follow_up_notes = excluded.follow_up_notes,
           additional_notes = excluded.additional_notes,
           transcript_summary = excluded.transcript_summary,
           status = excluded.status,
           synced_at = datetime('now')
         RETURNING id`,
      )
        .bind(
          args.retell_chat_id,
          args.tech_id,
          args.tech_name,
          args.tech_phone,
          args.job_id ?? null,
          args.customer_name ?? null,
          jobComplete,
          partsUsed,
          followUpType,
          args.follow_up_notes ?? null,
          args.additional_notes ?? null,
          args.transcript_summary ?? null,
          debriefStatus,
        )
        .run() as { results: Array<{ id: number }>; success: boolean };

      const debrief_id = result?.results?.[0]?.id ?? null;
      return { status: 'saved', debrief_id };
    } catch (err) {
      return { status: 'db_error', message: `Save failed: ${String(err)}` };
    }
  },
};
