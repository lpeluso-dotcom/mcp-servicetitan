# Recurring service API contract — QUA-1452

Retrieved 2026-09-06 from ServiceTitan's [Memberships v2 OpenAPI](https://developer.servicetitan.io/api/docs/apis/tenant-memberships-v2). The ticket's original description contains assumptions that the published contract does not support.

| Tool | Verified API contract |
|---|---|
| `list_recurring_service_events` | `GET /memberships/v2/tenant/{tenant}/recurring-service-events`. Server filters include locationId, jobId, status, modifiedOnOrAfter and modifiedBefore. There is no membershipId query filter: the tool filters each returned page locally and preserves upstream pagination. |
| `mark_recurring_service_event` | `POST .../recurring-service-events/{id}/mark-complete` or `mark-incomplete`, both requiring `{jobId}`. Completion links a job and copies invoice-template items to its invoice. Incompletion unlinks the job and deletes those copied invoice items. Neither is a simple dismiss toggle. |
| `update_recurring_service` | `PATCH .../recurring-services/{id}`. The tool exposes the documented recurrence fields and `from` (the beginning date). There is no nextDate or nextScheduledDate field; a direct event-date edit is not implemented. |

The public specification does not document whether these event actions recognize deferred revenue. It has no equivalent of the UI's revenue-recognition checkbox. Do not claim either recognition or no recognition, or use this tool for unattended arrears cleanup on that assumption. No job cancellation is performed.

All writes use the existing factory's dryRun-default preview and actor/argument-bound confirmation token; readonly and lockdown roles cannot discover them. The health toolCount is calculated from the catalog, now 116; default role has 115. This change was validated with mocks only: no ServiceTitan writes or live write probes. Deployment remains separately reviewable under QUA-1452; a schema-confirmed tool is not production verification.
