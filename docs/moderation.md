# Shared-content safety and moderation

## Scope and release check

The moderation controls cover hosted plan codes, trainer profiles, trainer/client names, assigned plans and workout summaries. Personal account documents and private photos stay outside the shared-text filter. The same consent, generation, account isolation and RevenueCat checks still apply.

The SQL upgrade is transactional and rerunnable. Deploy the complete `supabase-setup.sql` with the matching client. The existing `coach-access` Edge Function already returns the database's editable moderation errors. This change adds no Edge route, provider, credential or automatic email.

Before release, test the new client and RPCs together using synthetic accounts on the dedicated project. Local PGlite and mocked Edge tests exercise the database rules and error propagation. They do not prove hosted concurrency or App Review acceptance.

Apple requires filtering, reporting with timely responses, blocking and published contact details for user-contributed content. The service operator must provide and maintain the reporting and moderation process. Check the queue routinely, respond to concerns promptly, act on violations and handle appeals through the published support contact. Review content in the authenticated project dashboard and avoid copying personal content into tickets or logs. [Apple App Review Guideline 1.2](https://developer.apple.com/app-store/review/guidelines/#user-generated-content)

## Filtering and delivery

`iron_atlas_private.shared_text_allowed(jsonb)` examines every string represented in the submitted JSON, including nested free-text fields. It lowercases text, removes common zero-width characters, normalizes common letter substitutions, then applies an English objectionable-word and threat-phrase filter. Rejected submissions return an editable error before publication. The application can run an equivalent precheck for immediate feedback.

The filter is a baseline. Human review handles context, evasion and other languages. Update the SQL filter and matching client precheck together when reports identify a gap. A rejected submission is never copied into a quarantine table.

Database triggers protect inserts and updates to the shared tables. Read paths also check the filter, publishing suspension and user blocks, so an older unsafe row cannot bypass delivery controls. Suspended publishing covers both directions of the trainer relationship. Suspending an account removes hosted codes, current trainer links, associated summaries and queued assignments. Account sign-in, purchases and personal device/account documents remain available.

Hosted plans receive an immutable content UUID. The generated source object contains `kind`, `reference` and `author`. Its reference identifies a particular publication even if a six-character code is reused later. The server replaces submitted source metadata with its own values. Assigned deliveries contain the trainer UUID in `author` and retain their assignment ID.

Authenticated plan retrieval honors blocks in either direction. Anonymous code retrieval cannot identify a reader and therefore applies the text filter, consent and global publishing restrictions. Signed-in clients must send their session bearer token when retrieving a plan. The UI must hide a blocked author's previously cached content. Copies already exported or retained elsewhere remain outside the service's removal controls.

New sharing uses identifiable hosted codes. Existing `IA1-` files can remain a local personal-file import with a clear unverified-source explanation and the client filter. They carry no authenticated author identity. Do not present their author text as a verified account or offer an account report/block action using metadata inside the file. Preserve existing personal plans and backups.

## Client RPC contract

All four safety RPCs require an authenticated account that still exists. They work independently of optional backup consent.

| RPC | Arguments | Result |
| --- | --- | --- |
| `block_peer` | `p_peer` UUID | `{ "blocked": true }` |
| `unblock_peer` | `p_peer` UUID | `{ "blocked": false }` |
| `blocked_peers` | none | Array of `{ "id", "blocked_at" }` |
| `report_content` | `p_kind`, `p_reference`, `p_reason` | `{ "id", "status": "open" }` |

Report kinds are `shared_plan`, `assigned_plan` and `peer`. Their references are the immutable hosted content UUID, assignment ID string and peer account UUID respectively. Reasons are `abuse`, `hate`, `sexual`, `violence`, `spam` and `other`. Reports accept an enum reason without a free-text body or copied workout data.

The server verifies that the caller could access the referenced content or has a corresponding delivery/relationship receipt. Repeating an open report returns the same ID. Each account can create ten new reports per hour. Closing reports does not reset that limit. The UI should keep a failed report retryable and show support contact details when a reference is no longer available.

Blocking removes the connection, associated summary and queued plans in both directions. Repeating it is safe. Unblocking removes only the caller's block and does not restore a connection, queued plan or the other person's block. Normal connection consent is required again.

## Owner review in the dedicated Supabase project

Use the authenticated SQL editor or a server-only service-role client. These functions are unavailable to `anon` and `authenticated`. Never place a service key in the app or a public page.

Read a bounded oldest-first batch. `content` is fetched from the current source when available. For a peer report, this can include the name and summary currently shared with the reporter. An acknowledged assignment may already have been removed, so its content can be null. The receipt still identifies the account that sent it. No historical content snapshot is retained.

```sql
select public.moderation_list_reports(20);
```

If a reply is needed, locate the reporter in Auth using `reporter_id` and respond before closing the case. Closing clears that reference. After examining a real queue item, use its ID in one of these operations.

```sql
-- Replace the example UUID with the queue's report ID.
select public.moderation_resolve_report('00000000-0000-0000-0000-000000000000', 'dismiss');
select public.moderation_resolve_report('00000000-0000-0000-0000-000000000000', 'remove');
select public.moderation_resolve_report('00000000-0000-0000-0000-000000000000', 'suspend');
```

`remove` deletes the referenced hosted or queued plan. Use `suspend` for an abusive account reported as a peer. `suspend` also removes that account's existing hosted publications and trainer connections. Repeating resolution returns the closed outcome without acting again.

An appeal can restore publishing permission for an existing account. Removed publications and connections remain removed.

```sql
-- Replace the example UUID with the reviewed account ID.
select public.moderation_set_publishing_suspended('00000000-0000-0000-0000-000000000000', false);
```

The same function with `true` can suspend a verified abusive publisher outside a particular report. Record the decision through the support process without duplicating health content. After resolving a batch, read the queue again and confirm the intended content is unavailable through both anonymous and authenticated retrieval.

## Data lifecycle and concurrency

Private safety tables store blocks, publication status, source identity receipts, report references and an account-level rate counter. They have RLS enabled and no direct grants to public client or service roles. Only the narrowly granted security-definer functions access them.

Delivery receipts contain account IDs, source kind and source reference. They allow reporting after an assignment is acknowledged or a relationship ends. They contain no name, plan body, workout summary or photo. Backup withdrawal retains these safety records and blocks while removing the training data covered by withdrawal.

Closing a report immediately clears reporter ID, subject ID, source kind and reference. Only its case ID, enum reason, outcome and timestamps remain. Deleting a subject account closes its open cases and clears those identifiers. Deleting a reporter clears their identifier from remaining open cases. Full account deletion also cascades blocks, source receipts, publication controls and rate counters. Account erasure and subscription-profile cleanup continue through their existing flow.

Publication and moderation mutations use the same short transaction-level advisory lock, acquired before Auth/consent row locks in normal write entry points. This orders a queued assignment or publication against blocking and suspension. The lock is limited to cross-user writes and account deletion. Personal account-document CAS does not take it. A read that began before a block can finish afterward, so the client also checks its current block state before displaying content.

## Focused verification

```text
node --test tests/moderation-sql.test.mjs tests/coach-sql.test.mjs tests/cloud-consent-sql.test.mjs tests/account-cas-sql.test.mjs tests/coach-access.test.mjs
```

Hosted verification should include two simultaneous assignment/block requests, authenticated versus anonymous shared-code retrieval, reporting after assignment acknowledgement, an operator removal and suspension, an unblock without automatic reconnection, withdrawal retaining blocks, and full account deletion clearing all subject identifiers. Use isolated synthetic identities and remove their remaining records after verification.

Supabase grants and RLS are separate controls, and public security-definer functions require explicit execute restrictions. This implementation keeps safety tables in the private schema and grants only the intended RPC surface. [Supabase API security](https://supabase.com/docs/guides/api/securing-your-api) [Supabase database functions](https://supabase.com/docs/guides/database/functions)
