// ============================================================
// resources/results.ts — Phase 2 Task 2.4
//
// Some composite/list tool results run 60KB-400KB, which bloats client
// context if inlined whole. offloadIfLarge() is the GATE inserted into
// tool-registry.ts's success-return path: under RESULT_THRESHOLD bytes,
// behavior is byte-identical to the prior inline path (same text content
// block + same structuredContent wrapping rule — see wrapStructuredContent,
// factored out of tool-registry.ts's former inline computation so there is
// exactly one implementation of that rule). Over threshold, the full JSON
// is stashed in KV (PROXY_STATE, key `result:{correlation}`, RESULT_TTL_S)
// and the tool call instead returns a short summary + an MCP resource_link
// content item. registerResultResource() wires the companion
// `mcp-st://results/{id}` resource template that reads the stash back on
// demand.
//
// SDK shape confirmed against
// node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts:
//   server.registerResource(name, uriOrTemplate: ResourceTemplate, config, readCallback)
//   new ResourceTemplate(uriTemplate, { list: undefined })
//   readCallback: (uri: URL, variables: Variables, extra) => { contents: [{uri, mimeType, text}] }
// and against ../types.js:
//   content item { type: 'resource_link', uri, name, description?, mimeType? } (name is required)
//   McpError(code: number, message) + ErrorCode.InvalidParams — the same code the SDK's own
//   built-in "no resource/template matched" path uses, so our "id not in KV" error is consistent
//   with SDK convention.
// ============================================================

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError as SdkMcpError, ErrorCode as SdkErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { Env } from '../env';

export const RESULT_THRESHOLD = 80_000;
export const RESULT_TTL_S = 900;

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'resource_link'; uri: string; name: string; description?: string; mimeType?: string };

export interface OffloadResult {
  offloaded: boolean;
  content: ContentBlock[];
  structuredContent: Record<string, unknown>;
}

/**
 * The structuredContent wrapping rule (must be an object per the MCP spec):
 * an object result passes through as-is; a bare array/primitive/null gets
 * wrapped as { result }. This is the SAME rule tool-registry.ts used inline
 * before this change — factored out here so both the under- and
 * over-threshold paths share one implementation and can't diverge.
 */
export function wrapStructuredContent(result: unknown): Record<string, unknown> {
  return result !== null && typeof result === 'object' && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : { result };
}

function resultKey(correlation: string): string {
  return `result:${correlation}`;
}

/** Shallow, cheap-to-compute summary: top-level keys + any array field lengths. */
function summarize(result: unknown): { keys: string[]; arrayLengths: Record<string, number> } {
  const arrayLengths: Record<string, number> = {};
  if (Array.isArray(result)) {
    return { keys: [], arrayLengths: { '(root)': result.length } };
  }
  if (result !== null && typeof result === 'object') {
    const obj = result as Record<string, unknown>;
    const keys = Object.keys(obj);
    for (const k of keys) {
      const v = obj[k];
      if (Array.isArray(v)) arrayLengths[k] = v.length;
    }
    return { keys, arrayLengths };
  }
  return { keys: [], arrayLengths: {} };
}

/**
 * Gate a tool's success result through the size threshold. Under
 * RESULT_THRESHOLD bytes: no KV write, same content/structuredContent shape
 * as before this change. Over threshold: write the full JSON to KV and
 * return a short summary + resource_link instead.
 */
export async function offloadIfLarge(
  env: Env,
  correlation: string,
  result: unknown
): Promise<OffloadResult> {
  const text = JSON.stringify(result ?? null);

  if (text.length <= RESULT_THRESHOLD) {
    return {
      offloaded: false,
      content: [{ type: 'text', text }],
      structuredContent: wrapStructuredContent(result),
    };
  }

  const key = resultKey(correlation);
  await env.PROXY_STATE.put(key, text, { expirationTtl: RESULT_TTL_S });

  const { keys, arrayLengths } = summarize(result);
  const uri = `mcp-st://results/${correlation}`;
  const summaryText = [
    `Result too large to inline (${text.length} bytes > ${RESULT_THRESHOLD}-byte threshold).`,
    keys.length > 0 ? `Top-level keys: ${keys.join(', ')}.` : '',
    Object.keys(arrayLengths).length > 0
      ? `Array field lengths: ${Object.entries(arrayLengths)
          .map(([k, n]) => `${k}=${n}`)
          .join(', ')}.`
      : '',
    `Full result available at ${uri} (expires in ${RESULT_TTL_S}s) — read it via resources/read.`,
  ]
    .filter(Boolean)
    .join(' ');

  return {
    offloaded: true,
    content: [
      { type: 'text', text: summaryText },
      {
        type: 'resource_link',
        uri,
        name: 'full-result',
        description: `Full ${text.length}-byte result (expires in ${RESULT_TTL_S}s)`,
        mimeType: 'application/json',
      },
    ],
    structuredContent: {
      _truncated: true,
      _full: uri,
      _bytes: text.length,
      keys,
      arrayLengths,
    },
  };
}

/**
 * Register the `mcp-st://results/{id}` resource template. Reads the stash
 * written by offloadIfLarge() back out of PROXY_STATE KV. Missing/expired
 * id -> a friendly McpError (InvalidParams, same code the SDK's own
 * no-match path uses) rather than a raw KV null.
 */
export function registerResultResource(server: McpServer, env: Env): void {
  server.registerResource(
    'result',
    new ResourceTemplate('mcp-st://results/{id}', { list: undefined }),
    {
      title: 'Offloaded tool result',
      description: 'Full JSON payload for a tool result that exceeded the inline size threshold.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const raw = variables.id;
      const id = Array.isArray(raw) ? raw[0] : raw;
      const stored = id ? await env.PROXY_STATE.get(resultKey(id)) : null;
      if (!stored) {
        throw new SdkMcpError(
          SdkErrorCode.InvalidParams,
          `result ${id ?? '(unknown)'} expired or not found; re-run the tool that produced it`
        );
      }
      return {
        contents: [{ uri: uri.toString(), mimeType: 'application/json', text: stored }],
      };
    }
  );
}
