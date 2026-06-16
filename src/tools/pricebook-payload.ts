// ============================================================
// pricebook-payload — user→ST field-name transform for pricebook writes
//
// ST silently drops these pricebook fields on POST + PATCH:
//   - `name` is ignored; only `displayName` updates the customer-facing label
//   - `categoryId` (singular) is ignored; ST expects `categories: [<int>]`
//   - `useStaticPrice` (singular) is ignored; ST expects plural `useStaticPrices`
//
// We keep the user-facing arg names (`name`, `categoryId`) for ergonomics
// and back-compat, but rewrite the outbound payload at the boundary so ST
// actually persists the change. Observed in production 2026-05-12 when
// multiple pricebook services landed with displayName:null and categories:[].
// ============================================================
export function toStPricebookPayload<T extends Record<string, unknown>>(
  payload: T,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload };
  if ('name' in out) {
    out.displayName = out.name;
    delete out.name;
  }
  // Multi-cat: prefer `categories[]` if both passed.
  if ('categories' in out && Array.isArray(out.categories)) {
    delete out.categoryId;
  } else if ('categoryId' in out) {
    out.categories = [out.categoryId];
    delete out.categoryId;
  }
  // Belt-and-suspenders: singular useStaticPrice is silently dropped by ST.
  // Zod should already reject at the schema layer; this guards against bypasses.
  if ('useStaticPrice' in out) {
    delete out.useStaticPrice;
  }
  return out;
}
