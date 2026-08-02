// ============================================================
// redact — caller-facing PII / premises scrub for free-text chunks (QUA-1181).
//
// WHY THIS EXISTS, and why it is not the real fix.
//
// `vec.entity_chunks` embeds a `content_text` composed upstream in qsc-vector.
// For the `job` grain that template includes the raw ST job `summary`, which is
// operator-written prose and therefore carries whatever the office typed:
// customer names, street addresses, employee emails, and — the worst live
// probe on 2026-08-01 — a lockbox location, what the key opens, and the code's
// validity window. That is physical premises access, handed to any caller of
// `semantic_search_gold`.
//
// Two existing controls do NOT cover it, and it is worth being precise about
// why, because both have been mistaken for coverage before:
//
//   * `vec.pii_allowlist` is a NOUN registry (78 rows, measured 2026-08-01).
//     It decides which entity TYPES get embedded at all. It says nothing about
//     the VALUES inside a chunk.
//   * QUA-1018's PII gate is a COLUMN classifier. `content_text` is one column
//     and it is allowed; the gate cannot see inside it.
//
// So this module scrubs at the tool boundary. Because every door — `/mcp`
// (sync-key) and `/mcp-oauth` (OAuth `readonly` / `default`) — dispatches the
// same handler, scrubbing here covers all of them at once. That was the point:
// the audit found byte-identical leaks on the readonly and default doors, so a
// per-door fix would have had to be written twice and kept in sync.
//
// THE ROOT FIX IS ELSEWHERE. Chunk templates, not the read path, are where
// this is properly closed: stop embedding raw `summary` in the `job` grain in
// qsc-vector and re-embed. This module is the stop-the-bleeding layer that
// holds until then, and it should stay afterwards as defence in depth.
//
// FALSE POSITIVES ARE THE REAL DESIGN CONSTRAINT. The E.2.3 sweep found 8,345
// chunks matching a naive PII regex, but 7,364 of those were noise: 4,799
// `labor` chunks shaped `2026-05-01: 3.1234567890` (a date plus a 10-decimal
// float) and 2,551 `invoice_item` SKU codes shaped `100244-8891`, all matched
// by a bare \d{3}.?\d{3}.?\d{4}. A scrub built on that regex would corrupt
// those rows estate-wide while adding no safety. Every pattern below therefore
// requires either a real separator or a digit-run boundary, and the false-
// positive shapes are pinned as regression tests.
//
// Measured blast radius after discounting the noise (2026-08-01): the `job`
// grain carries 594 street-like and 245 premises-like chunks; `estimate_line`
// 98 and 1.
// ============================================================

/** Terms that mark a clause as granting physical access to a premises. */
const PREMISES_TERMS =
  /lock\s?box|gate\s?code|door\s?code|key\s?pad|keypad|garage\s?code|alarm\s?code|access\s?code|entry\s?code|combination|spare\s?key|hide[- ]?a[- ]?key/i;

const STREET_SUFFIX =
  'road|rd|street|st|avenue|ave|lane|ln|drive|dr|court|ct|circle|cir|boulevard|blvd|way|highway|hwy|place|pl|terrace|ter|trail|trl|parkway|pkwy';

/**
 * A street address: a house number followed by up to four name words and a
 * street-type suffix. The leading `(?<!\d)` stops it biting into a longer digit
 * run (an ST id, a SKU), which is what makes it safe against the `labor` and
 * `invoice_item` false-positive shapes.
 */
const ADDRESS_RE = new RegExp(
  String.raw`(?<![\d.-])\d{1,6}\s+(?:[A-Za-z0-9'.-]+\s+){0,4}?(?:${STREET_SUFFIX})\b\.?`,
  'gi',
);

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * US phone, in the formats the ST office actually types. Both branches are
 * deliberately conservative:
 *   - the separated branch REQUIRES a real separator between groups, so
 *     `2026-05-01` and `100244-8891` cannot match;
 *   - the bare branch requires exactly ten digits not adjacent to another
 *     digit, `.` or `-`, so the 10-decimal floats in the `labor` grain
 *     (`3.1234567890`) are excluded by the lookbehind.
 */
const PHONE_RE =
  /(?<![\d.-])(?:\+1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}(?![\d-])|(?<![\d.-])\d{10}(?![\d.-])/g;

/**
 * The XOi deep-link querystring. This is where the worst 2026-08-01 probe
 * leaked from: `payload=` carries a base64 blob that decodes to customer name
 * and address, so it defeats every value-level pattern above by encoding them.
 * Strip the parameter wholesale rather than trying to inspect it.
 */
const PAYLOAD_QS_RE = /\bpayload=[^\s&"'<>]*/gi;

/** Split into sentences, keeping the text of each (delimiters stay attached). */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?;])\s+/);
}

/**
 * Redact a single free-text value.
 *
 * Premises access is handled at CLAUSE granularity, not token granularity, and
 * that asymmetry is deliberate. "Lockbox" on its own is harmless; "lockbox is
 * on the back gate and the code 4417 opens the side door" is a break-in kit,
 * and the dangerous parts of it ("back gate", "side door") match no PII pattern
 * at all. Only the sentence carrying the term is dropped, so surrounding
 * operational context — the diagnosis, the parts, whether to bring a ladder —
 * survives. An over-broad scrub that blanks the whole chunk would make the tool
 * useless and get itself reverted.
 */
export function redactFreeText(text: string): string {
  if (!text) return text;

  let out = text.replace(PAYLOAD_QS_RE, '[payload redacted]');

  out = sentences(out)
    .map((s) => (PREMISES_TERMS.test(s) ? '[premises access redacted]' : s))
    .join(' ');

  out = out.replace(EMAIL_RE, '[email redacted]');
  out = out.replace(PHONE_RE, '[phone redacted]');
  out = out.replace(ADDRESS_RE, '[address redacted]');

  return out;
}

/** True when redaction would change the value — used to disclose to the caller. */
export function wouldRedact(text: string): boolean {
  return redactFreeText(text) !== text;
}
