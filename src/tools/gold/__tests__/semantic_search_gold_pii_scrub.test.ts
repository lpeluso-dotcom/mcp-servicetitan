// ============================================================
// semantic_search_gold — caller-facing PII / premises scrub (QUA-1181).
//
// This is the negative control §3.D.2 asked for and the 2026-08-01 audit
// could not produce: seed a job summary carrying a known phone, email,
// street address and lockbox string, then assert none of it survives to the
// caller. Before the scrub existed every one of these assertions failed —
// the handler returned `content_text` verbatim from the RPC.
//
// Why this layer. `vec.pii_allowlist` is a NOUN registry: it decides which
// entity TYPES get embedded, not which VALUES are safe (trade_coverage.ts).
// QUA-1018's PII gate is a COLUMN classifier and cannot see inside an
// embedded free-text `content_text`. Three live probes on the OAuth
// `readonly` door returned a customer name + street address + employee
// email, and a lockbox location + what the key opens + the code's validity
// window — byte-identical on the `default` door, so no caller-facing
// redaction existed on either.
//
// Scrubbing here (the tool boundary) covers BOTH doors at once, because
// every door dispatches the same handler. It is deliberately a stop-the-
// bleeding measure: the root fix is re-templating the `job` grain chunk in
// qsc-vector so raw `summary` is never embedded. Measured 2026-08-01, the
// job grain carries 594 street-like and 245 premises-like chunks.
//
// The strings below are synthetic. Do not paste real customer data here.
// ============================================================
import { describe, it, expect, vi, afterEach } from 'vitest';
import { semantic_search_gold } from '../semantic_search_gold';

function env(aiRun: any) {
  return { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_PB_KEY: 'k', AI: { run: aiRun } } as any;
}
const ctx = { actor: 'test', correlation: 'c1' };
const ai = () => vi.fn(async () => ({ data: [[0.1, 0.2]] }));

function rpcReturning(rows: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(rows), { status: 200 })) as any);
}

/** One job-grain chunk with the given free text, scoring above the 0.75 floor. */
function jobChunk(content_text: string, source_key = '77423990') {
  return [{
    entity_key: 'job',
    source_key,
    content_text,
    grain: 'job',
    trade_bu: 'HVAC Service Residential',
    similarity: 0.87,
  }];
}

afterEach(() => vi.unstubAllGlobals());

describe('semantic_search_gold PII scrub: the QUA-1181 leak shapes', () => {
  it('removes a street address from a job summary', async () => {
    rpcReturning(jobChunk('Customer at 1420 Ebenezer Road reported no cooling upstairs.'));

    const out: any = await semantic_search_gold.handler(env(ai()), { query: 'no cooling' }, ctx);
    const text = JSON.stringify(out);

    expect(text).not.toContain('1420 Ebenezer Road');
    expect(out.matches[0].content_text).toContain('[address redacted]');
  });

  it('removes a phone number in any common US format', async () => {
    for (const phone of ['843-555-0147', '(843) 555-0147', '843.555.0147', '8435550147', '+1 843-555-0147']) {
      rpcReturning(jobChunk(`Call back at ${phone} before dispatch.`));
      const out: any = await semantic_search_gold.handler(env(ai()), { query: 'call back' }, ctx);
      expect(JSON.stringify(out), `leaked format: ${phone}`).not.toContain('555-0147');
      expect(JSON.stringify(out), `leaked format: ${phone}`).not.toContain('5550147');
    }
  });

  it('removes an employee or customer email address', async () => {
    rpcReturning(jobChunk('Escalated to tsmith@qualityservicecompany.net for approval.'));

    const out: any = await semantic_search_gold.handler(env(ai()), { query: 'escalated' }, ctx);

    expect(JSON.stringify(out)).not.toContain('tsmith@qualityservicecompany.net');
    expect(out.matches[0].content_text).toContain('[email redacted]');
  });

  // The worst live probe: physical premises access. The sensitive part is the
  // whole clause, not the keyword — "lockbox" alone is harmless, "lockbox on
  // the back gate, code 4417, good through Friday" is a break-in kit.
  it('removes the entire premises-access clause, not just the keyword', async () => {
    rpcReturning(jobChunk(
      'Unit is in the crawlspace. Lockbox is on the back gate and the code 4417 opens the side door; good through Friday. Tech should bring a ladder.',
    ));

    const out: any = await semantic_search_gold.handler(env(ai()), { query: 'crawlspace unit' }, ctx);
    const text = JSON.stringify(out);

    expect(text).not.toContain('4417');
    expect(text).not.toContain('back gate');
    expect(text).not.toContain('side door');
    expect(out.matches[0].content_text).toContain('[premises access redacted]');
    // Non-sensitive operational context must survive — an over-broad scrub
    // that nukes the whole chunk makes the tool useless.
    expect(out.matches[0].content_text).toContain('crawlspace');
    expect(out.matches[0].content_text).toContain('ladder');
  });

  it('strips the XOi payload= querystring that leaked the worst probe', async () => {
    rpcReturning(jobChunk(
      'Photos: https://xoi.io/v/abc?payload=eyJjdXN0b21lciI6IkpvaG4gRG9lIiwiYWRkciI6IjE0MjAgRWJlbmV6ZXIifQ== uploaded.',
    ));

    const out: any = await semantic_search_gold.handler(env(ai()), { query: 'photos' }, ctx);
    const text = JSON.stringify(out);

    expect(text).not.toContain('eyJjdXN0b21lciI');
    expect(text).not.toContain('payload=');
  });

  it('scrubs every returned match, not just the first', async () => {
    rpcReturning([
      { entity_key: 'job', source_key: '1', content_text: 'Meet at 12 Oak Street for the swap.', grain: 'job', trade_bu: null, similarity: 0.90 },
      { entity_key: 'job', source_key: '2', content_text: 'Reach the owner on 843-555-0188.', grain: 'job', trade_bu: null, similarity: 0.88 },
      { entity_key: 'job', source_key: '3', content_text: 'Gate code is 9931 for the rear lot.', grain: 'job', trade_bu: null, similarity: 0.86 },
    ]);

    const out: any = await semantic_search_gold.handler(env(ai()), { query: 'swap', k: 5 }, ctx);
    const text = JSON.stringify(out);

    expect(out.matches.length).toBe(3);
    expect(text).not.toContain('12 Oak Street');
    expect(text).not.toContain('555-0188');
    expect(text).not.toContain('9931');
  });
});

describe('semantic_search_gold PII scrub: does not damage clean text', () => {
  // The E.2.3 sweep found 4,799 "phone" hits in the labor grain that were
  // really `2026-05-01: 3.1234567890` — a date plus a 10-decimal float. A
  // naive \d{3}.?\d{3}.?\d{4} scrub would corrupt those rows estate-wide, so
  // the false-positive shapes are pinned here as regression tests.
  it('leaves dates, decimals and ST ids intact', async () => {
    const clean = 'HVAC Service Residential — 2026-05-01: 3.1234567890 working hours on job 77423990, SKU 100244-8891.';
    rpcReturning(jobChunk(clean, '77423990'));

    const out: any = await semantic_search_gold.handler(env(ai()), { query: 'labor hours' }, ctx);

    expect(out.matches[0].content_text).toBe(clean);
  });

  it('leaves an ordinary parts-and-symptom summary untouched', async () => {
    const clean = 'Replaced OEM condenser fan motor and capacitor; unit cycling on high-pressure lockout.';
    rpcReturning(jobChunk(clean));

    const out: any = await semantic_search_gold.handler(env(ai()), { query: 'condenser fan motor' }, ctx);

    expect(out.matches[0].content_text).toBe(clean);
  });
});
