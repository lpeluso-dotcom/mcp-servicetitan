// ============================================================
// Task 6.4 — Tool-selection eval scenarios.
//
// ~20 realistic QSC (Quality Service Company — HVAC/electrical/plumbing,
// ServiceTitan tenant 431848990) natural-language operator questions, each
// paired with the tool name(s) from the live registry (src/tools/index.ts
// TOOLS) that would correctly answer it. Every `expected` name is grounded
// against the real registry — src/__tests__/eval-scenarios.test.ts enforces
// this in CI via validateScenarios(TOOLS, scenarios).
//
// `expected` is an array because several queries have more than one
// defensible answer (e.g. a composite tool vs. its underlying primitive, or
// two tools that both surface the same fact) — scoring in
// scripts/evals/tool-selection.ts treats any member as correct so a
// reasonable model isn't penalized for picking an equally valid tool.
//
// Queries are written in plain operator phrasing — none leak a literal tool
// name — and, per QSC's dynamic-pricing rule, no query/rationale ever
// claims a pricebook item is "free"/"unpriced"/"$0".
// ============================================================

export interface EvalScenario {
  id: string;
  query: string;
  /** One or more tool names (from TOOLS) that would correctly answer the query. */
  expected: string[];
  /** Why the expected tool(s) are the right pick — used when reading eval failures. */
  rationale: string;
}

export const scenarios: EvalScenario[] = [
  {
    id: 'job-margin',
    query: 'What did we actually make on job 87421?',
    expected: ['job_cost_actuals', 'margin_audit', 'job_closeout_report'],
    rationale:
      'Asks for realized profitability on a specific job — any of the three job-level cost/margin composites answers it; there is no single canonical "the" tool.',
  },
  {
    id: 'find-customer',
    query: 'Find the customer Jane Smith at 12 Oak St',
    expected: ['find_customer'],
    rationale: 'Name + address customer lookup is exactly the purpose of find_customer.',
  },
  {
    id: 'memberships-expiring',
    query: 'Which memberships expire next month?',
    expected: ['list_memberships_expiring'],
    rationale: 'Direct match — a dedicated tool exists for exactly this list.',
  },
  {
    id: 'unpaid-invoices',
    query: 'Show me all unpaid invoices',
    expected: ['list_unpaid_invoices'],
    rationale: 'Direct match to the unpaid-invoices list tool.',
  },
  {
    id: 'capacity-today',
    query: "Who's working today and are we at capacity?",
    expected: ['list_jobs_today', 'get_capacity'],
    rationale:
      'Compound question spanning who is scheduled today and whether the schedule is full — either tool (or both together) is a defensible top pick.',
  },
  {
    id: 'customer-note',
    query: 'Add a note to customer 261837 that they prefer morning appointments',
    expected: ['add_customer_note'],
    rationale: 'Write action: attach a note to a customer record — direct match, and a write-tool case.',
  },
  {
    id: 'pricebook-price',
    query: "What's the price of a P1HL22 service?",
    expected: ['search_pricebook_services', 'search_pricebook_all'],
    rationale:
      'Looking up a specific service code could resolve via the services-only search or the merged pricebook search — both are correct entry points. (Note: price is computed dynamically at invoice time; this scenario only tests lookup routing.)',
  },
  {
    id: 'customer-snapshot',
    query: 'Give me the full picture on customer 445210 — jobs, invoices, membership status, everything',
    expected: ['customer_snapshot'],
    rationale:
      '"Everything about this customer" is a broad, multi-domain ask that matches the composite snapshot tool over any single-domain lookup.',
  },
  {
    id: 'dispatch-override',
    query: "Did dispatch override any of Scheduling Pro's recommendations this week?",
    expected: ['dispatch_override_audit'],
    rationale: 'Specifically about manual overrides of automated dispatch — the dedicated audit composite.',
  },
  {
    id: 'call-quality',
    query: 'How did our CSRs handle inbound calls yesterday — anyone missing the pitch?',
    expected: ['call_quality_review'],
    rationale: 'A coaching/quality ask about how calls were handled maps to the call-quality composite, not a raw call lookup.',
  },
  {
    id: 'payroll-hours',
    query: 'How many hours did the plumbing crew log on job 90142 this week?',
    expected: ['payroll_job_timesheets_list'],
    rationale: 'Job-scoped labor hours is the job timesheets list, not the general payroll run or non-job timesheets.',
  },
  {
    id: 'opportunities-open',
    query: "What open sales opportunities do we have sitting untouched right now?",
    expected: ['opportunities_list', 'open_opportunities_pulitzer_feed'],
    rationale: 'General open-opportunity ask — either the raw opportunities list or the curated open-opportunities feed is defensible.',
  },
  {
    id: 'estimate-status',
    query: 'Pull up the estimates on job 77890 and tell me which ones are still pending',
    expected: ['list_estimates_job'],
    rationale: 'Job-scoped estimate listing — direct match.',
  },
  {
    id: 'sell-estimate',
    query: 'The customer just verbally approved estimate 55210 — mark it sold',
    expected: ['sell_estimate'],
    rationale: 'Write action converting an approved estimate to sold status — direct match, and a write-tool case.',
  },
  {
    id: 'book-job',
    query: 'Book a plumbing job for tomorrow at 9am for customer 300112 at their Oak St location',
    expected: ['book_job'],
    rationale: 'Write action creating a new job/appointment — direct match, and a write-tool case.',
  },
  {
    id: 'capacity-slots',
    query: 'What appointment slots are open for HVAC this Thursday?',
    expected: ['st_get_capacity_slots', 'get_capacity'],
    rationale:
      'Slot-level availability search could resolve to the dedicated slot finder or the general capacity tool — both are defensible.',
  },
  {
    id: 'tech-drive-time',
    query: 'Which techs are burning the most windshield time between calls this month?',
    expected: ['tech_drive_time_summary'],
    rationale: 'Drive-time / efficiency question maps to the dedicated drive-time composite, not raw dispatch data.',
  },
  {
    id: 'vendor-part-gaps',
    query: 'Are there pricebook services missing a linked vendor part?',
    expected: ['pricebook_vendor_part_gaps'],
    rationale: 'A pricebook-data-quality question about missing vendor-part links — the dedicated gap-audit composite.',
  },
  {
    id: 'campaign-performance',
    query: "How's our Google Ads campaign performing this quarter — calls, bookings, revenue?",
    expected: ['get_campaign_performance'],
    rationale: 'Campaign-level ROI/performance rollup — direct match.',
  },
  {
    id: 'create-task',
    query: 'Create a follow-up task for the office manager to call customer 512093 back about their quote',
    expected: ['create_task'],
    rationale: 'Write action creating an internal follow-up task — direct match, and a write-tool case.',
  },
  {
    id: 'inventory-warehouse',
    query: 'What warehouses do we have inventory stocked in?',
    expected: ['inventory_warehouses_list'],
    rationale: 'Direct match to the warehouse listing tool.',
  },
  {
    id: 'membership-outreach',
    query: "Which members haven't been reached out to in a while and might be at risk of lapsing?",
    expected: ['membership_outreach_list'],
    rationale:
      'A proactive-retention ask, distinct from the simple expiring-memberships list — matches the dedicated outreach composite.',
  },
];
