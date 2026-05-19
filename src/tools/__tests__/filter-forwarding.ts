import { expect } from 'vitest';

export function endpointFromProxyUrl(url: unknown): string {
  const parsed = new URL(String(url));
  const endpoint = parsed.searchParams.get('endpoint');
  if (!endpoint) throw new Error(`missing endpoint query param in ${String(url)}`);
  return endpoint;
}

export function expectForwardedQuery(url: unknown, key: string, value: string): void {
  const endpoint = endpointFromProxyUrl(url);
  const query = endpoint.split('?')[1] ?? '';
  expect(new URLSearchParams(query).get(key)).toBe(value);
}

export function expectNoForwardedQuery(url: unknown, key: string): void {
  const endpoint = endpointFromProxyUrl(url);
  const query = endpoint.split('?')[1] ?? '';
  expect(new URLSearchParams(query).has(key)).toBe(false);
}
