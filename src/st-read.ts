import type { Env } from './env';
import { authHeaders } from './auth';
import { McpError, mapUpstreamStatus } from './errors';

export type QueryValue = string | number | boolean | null | undefined;

export interface ReadSTOptions {
  actor: string;
  correlation: string;
  query?: Record<string, QueryValue>;
}

export function appendDefinedQuery(qs: URLSearchParams, key: string, value: QueryValue): void {
  if (value !== undefined && value !== null) {
    qs.set(key, String(value));
  }
}

export function buildSTEndpoint(path: string, query?: Record<string, QueryValue>): string {
  const qs = new URLSearchParams();
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      appendDefinedQuery(qs, key, value);
    }
  }
  const sep = path.includes('?') ? '&' : '?';
  const suffix = qs.toString();
  return suffix ? `${path}${sep}${suffix}` : path;
}

export async function readST<T = unknown>(
  env: Env,
  path: string,
  options: ReadSTOptions,
): Promise<T> {
  const endpoint = buildSTEndpoint(path, options.query);
  const resp = await env.ST_PROXY.fetch(
    `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(endpoint)}`,
    { headers: authHeaders(env, options.correlation, options.actor) },
  );

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new McpError(
      mapUpstreamStatus(resp.status),
      `ST read failed: ${resp.status} ${endpoint} ${body.slice(0, 200)}`.trim(),
      { correlation: options.correlation },
    );
  }

  return resp.json<T>();
}

export function extractSTArray<T = unknown>(data: unknown): T[] {
  if (data !== null && typeof data === 'object') {
    const obj = data as { data?: T[]; items?: T[] };
    if (Array.isArray(obj.data)) return obj.data;
    if (Array.isArray(obj.items)) return obj.items;
  }
  return [];
}

export async function readSTArray<T = unknown>(
  env: Env,
  path: string,
  options: ReadSTOptions,
): Promise<T[]> {
  return extractSTArray<T>(await readST(env, path, options));
}
