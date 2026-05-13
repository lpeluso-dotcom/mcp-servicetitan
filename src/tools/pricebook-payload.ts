// ============================================================
// pricebook-payload — user→ST field-name transform for pricebook writes
//
// ST silently drops two pricebook fields on POST + PATCH:
//   - `name` is ignored; only `displayName` updates the customer-facing label
//   - `categoryId` (singular) is ignored; ST expects `categories: [<int>]`
//
// We keep the user-facing arg names (`name`, `categoryId`) for ergonomics
// and back-compat, but rewrite the outbound payload at the boundary so ST
// actually persists the change. Documented in
// qsc-infra/.claude/rules/servicetitan.md and observed on 2026-05-12 when
// 5 REPIPE-* services landed with displayName:null and categories:[].
// ============================================================
export function toStPricebookPayload<T extends Record<string, unknown>>(
  payload: T,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload };
  if ('name' in out) {
    out.displayName = out.name;
    delete out.name;
  }
  if ('categoryId' in out) {
    out.categories = [out.categoryId];
    delete out.categoryId;
  }
  return out;
}
