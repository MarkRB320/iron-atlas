# Cloud-training consent contract

The consent-aware client, SQL and Edge Functions form one pre-release update. Earlier debug builds must be replaced before use with this backend. Apply the complete rerunnable `supabase-setup.sql` to the selected isolated project only after local checks and review. Deploy the matching `coach-access` and `cloud-photo-remove` functions. Publisher review of the applicable legal obligations remains necessary.

## Choice and receipts

The explicit notice version is `2026-11-02`. It covers cloud backup of workouts, measurements and progress photos, together with the personal training information shared through the selected trainer/plan features. The interface must present the choice separately from account creation and terms acceptance, initially unticked. Merely signing in must never call the grant RPC.

The versioned backup choice reads “I agree to cloud storage and syncing of my workout records, training plans and preferences, body measurements and progress photos, for backup and access on my signed-in devices.” Trainer sharing also has its own disclosure when connecting. Keep the statement and explanatory material with the release source. A material change requires a new version and review of existing consents.

`cloud_consent` stores the current user-scoped state. `cloud_consent_receipts` records only user ID, generation UUID, notice version, action (`grant`, `withdraw`, `cleanup`) and server time. The browser cannot read or mutate either table directly. These records contain no workout, measurement or photo content. Full account deletion cascades to both tables. Consent withdrawal retains them with the continuing account. Their approved retention criteria remain an owner decision.

All client-callable account RPCs derive the owner from `auth.uid()`. They reject deleted accounts even when an old bearer token has not expired. Authentication, purchase identity and the trainer profile do not require consent to back up the owner's personal training records.

## Status and transitions

`cloud_consent_status()` returns the following JSON shape.

```json
{
  "enabled": false,
  "version": "2026-11-02",
  "generation": null,
  "cleanup_pending": false,
  "granted_at": null,
  "withdrawn_at": null
}
```

`version` is the currently required notice version. `generation` is a server-created UUID after the first transition. Dates are server timestamps. A new empty account has the shape above. An upgrade detects legacy personal documents, photos, hosted plan codes, client relationships, summaries or inbound assignments and creates a disabled, pending state. It preserves their content for recovery and does not fabricate a grant or withdrawal timestamp or receipt. Cleanup must finish before a new grant.

* `grant_cloud_consent(p_version text, p_expected_generation uuid)` requires the exact notice version and the generation most recently read by that client, including JSON null for a new account. Pending cleanup blocks it. An off-to-on grant creates a new generation. Retrying an already enabled generation returns its unchanged status and creates no duplicate receipt. A lost first grant response requires a status read before retrying.
* `begin_cloud_withdrawal(p_expected_generation uuid)` requires that same optimistic generation check. It disables cloud training writes and sets cleanup pending. Repeating it is safe. If that generation already completed withdrawal, it returns the completed state. It never revokes a newer generation.
* `finish_cloud_withdrawal(p_generation uuid)` requires the current disabled generation and a completed begin step. It refuses to finish while any `progress-photos` object has the user's folder prefix. After object removal it deletes the user's `app_state`, clears pending and appends one cleanup receipt. Repeating it returns the same state.

Each successful transition returns the status shape above. A generation/version conflict is an error. Refresh status and retain local work. Do not turn an error into a fresh grant.

## Withdrawal ordering and scope

1. Persist the initiating device's complete local data and a durable withdrawal operation receipt.
2. Resume unfinished photo removals through the Edge route with `purpose: "resume"`, then call begin. If a concurrent earlier removal won the account lock, begin returns `Photo removal is in progress. Resume it before turning off backup.` with PostgreSQL code `P0001`. Retry resume then begin within the same captured generation. From begin's successful commit, further cloud-training writes and ordinary photo deletions are refused by the server. A lost response is recoverable through status and a same-generation retry.
3. Read the now-frozen personal `app_state`. List and download the user's existing private photos as needed to preserve the device copy. Persist the merged/reviewed local copy and operation progress before deleting cloud content.
4. Remove every object under the user's `progress-photos` folder through `cloud-photo-remove` using `purpose: "withdrawal"`, the captured generation and batches of at most 100 bucket-relative names. The Edge Function uses the Storage HTTP API. Include nested generation folders and older flat filenames. Restart from listing on retry. SQL must never delete rows from `storage.objects` to remove files.
5. Call finish. A remaining file causes an error, allowing removal to resume. Persist completion locally. Authentication and local data remain available.

Begin immediately deletes the user's client-to-trainer relationship, personal trainer summary, all inbound queued assignments and all hosted plan codes owned by that user. Those routes may contain personal training information or free-text notes. Generic and personal hosted codes cannot reliably be distinguished, so both are removed. Codes already copied/imported and material a recipient already saved remain with the recipient. The initiating client must explain this scope before beginning.

The owner's `coaches` profile, code and name remain. Relationships where the withdrawing user is the trainer remain, as do queued assignments for those other consenting clients. Coach roster access and assigning plans still require the verified Coach entitlement. Withdrawing personal backup therefore permits continued independent trainer work for other clients.

Personal documents and private photos remain owner-readable only during enabled backup or pending cleanup. Pending is a recoverable deletion operation, with no fixed automatic expiry promised. The product needs an owner-approved abandoned-cleanup support/retention procedure. The user can complete full account deletion independently, including while withdrawal is pending.

## Write and read boundaries

* `commit_app_state(p_expected jsonb, p_docs jsonb, p_generation uuid)` retains the atomic JSON compare-and-swap result `{ "applied": true|false }`. It also requires the currently enabled generation. The old two-argument function is removed. Direct document INSERT/UPDATE remain unavailable to authenticated clients.
* New photo names are `<user UUID>/<generation UUID>/<photo filename>`. INSERT/UPDATE require the current enabled generation and standard authenticated upload operation. Older names remain available for pending cleanup but cannot be overwritten. Owner listing remains available for complete account deletion. Direct Storage DELETE is denied. Downloads require enabled backup or pending cleanup. New signed download/upload URLs, copy/move, S3 and resumable routes are outside this client protocol and receive no permission.
* `summary_put(p_summary jsonb, p_generation uuid)`, `assigned_pending(p_generation uuid)` and `assigned_ack(p_ids text[], p_generation uuid)` require the active generation. The earlier signatures and destructive `assigned_take()` are removed.
* `shared_plans` INSERT includes `consent_generation` with the active generation and `sharing_notice_version: "2026-11-02"` following the separate pre-publication confirmation. A trigger requires the version and overwrites `sharing_acknowledged_at` with server time. Plan-code lookup requires that receipt and the publishing owner's active generation. Legacy unacknowledged codes remain stored but unavailable to public lookup. Direct DELETE is denied; begin and full account deletion remove owned codes.
* Coach Edge operations `coach_join` and `coach_assign` require `args.p_generation`. Join also requires `args.p_sharing_version: "2026-11-02"` following a separate, initially unticked trainer-sharing agreement. The relation stores that version and a server acknowledgement timestamp. Join uses the joining person's generation. Assign uses the target client's `generation` field returned by the Coach roster. The Edge Function forwards the fields to the service-only checked RPC, where SQL checks them under lock. Client-provided actor/entitlement fields remain ignored. Legacy relations without the sharing receipt are hidden from roster/status and cannot accept summaries or new assignments. Explicit rejoining renews the receipt.
* `wipe_app_state(p_generation uuid)` replaces direct document DELETE and requires enabled consent. `coach_leave(p_generation uuid)` and `coach_remove(p_client uuid, p_generation uuid)` compare the captured owner or target-client generation before deleting a relationship.
* `delete_my_account(p_generation uuid)` compares the captured generation and requires all private photos removed. JSON null is valid for an account that has no consent record. The app and public portal capture status once at the start of a confirmed deletion and use it for every step. They must never refresh into a new generation halfway through a destructive action. Its JSON result is `{deleted: true, subscription_erasure_queued: boolean}`. Clients that previously ignored the successful response body remain compatible.

## Photo removal protocol

POST `/functions/v1/cloud-photo-remove` with the user bearer token and `{generation, purpose, names}`. The generation may be null for a never-consented account. Names are exact bucket-relative paths under that authenticated user's folder, with a maximum of 100 per request. The response contains only `{removed: number}`. The route never logs or returns filenames or image data.

* `photo` requires enabled consent. Use it for ordinary photo deletion and clearing active backup data.
* `withdrawal` requires pending cleanup and a recorded begin step. Use it only after the device copy has been preserved.
* `account` permits independently confirmed full account deletion with any current generation, including null. It does not require backup consent.
* `resume` drains an earlier durable removal operation. Pass an empty names array before beginning withdrawal.

`authorize_photo_removal(p_generation, p_purpose, p_names)` serializes on the account and records exact existing names in a private `photo_removal_intents` row. It returns an existing unfinished intent before accepting another operation. The Edge Function removes those names through Storage HTTP and calls service-only `complete_photo_removal(p_actor, p_operation)`, which checks that the metadata rows are absent. The public client cannot mark an intent complete. The Edge Function drains at most three operations per invocation, then returns a retryable error if more work remains.

An unfinished removal blocks the initial begin transition. A crash before or after the HTTP call leaves a resumable intent. Completed intents reserve their old paths against further uploads during that consent generation. This prevents an overlapping retry from deleting a replacement photo after the first call completed. Use a new photo ID when adding a replacement. Completed intents are cleared at completed cloud withdrawal or full account deletion; a subsequent consent generation always uses a different path prefix.

Independent account deletion remains an explicit destructive operation during pending withdrawal. Normal queued photo deletions are refused in that phase. Capture the account, generation and exact photo path before asynchronous work in the client, and discard results when that identity changes.

## Purchase-profile erasure queue

`account_erasure_settings` is publisher-controlled, with a single `singleton = true` row, an `enabled` flag and the expected RevenueCat `project_id`. No browser role can read or update it. Enable it only when the matching worker configuration is ready. When enabled, `delete_my_account` inserts an `account_erasure_jobs` row inside the same transaction before deleting Auth. The job snapshots the server-derived account UUID as `customer_id` and the configured project. It has no Auth foreign key, so the erasure request survives account deletion. It contains no email, workout, measurement or photo content.

The `account-erasure` Edge worker uses a one-use scheduler token, with platform `verify_jwt = false`. Each runner invocation generates a random 256-bit token, stores only its hash and a 120-second expiry in `iron_atlas_private.account_erasure_invocations`, and puts the raw short-lived token in the HTTP request. The worker hashes the supplied token and calls service-only `consume_account_erasure_invocation(p_hash)` before any provider activity. Atomic deletion permits one successful consumption. The private table has no public, anonymous, authenticated or service-role direct grants. The worker must then verify RevenueCat access and compare each claimed `project_id` with its configured project before making a customer request.

The final worker environment uses `SUPABASE_URL`, the platform-provided Supabase service key, `REVENUECAT_PROJECT_ID` and `REVENUECAT_V2_SECRET_KEY`. Invocation authority comes from the private one-use registry. The earlier `ACCOUNT_ERASURE_WORKER_SECRET` and `ACCOUNT_ERASURE_WORKER_SECRET_HASH` settings are obsolete and must be removed during the protocol upgrade.

The parent observed that the managed pg_net tables retained PUBLIC privileges granted by their `supabase_admin` owner despite the earlier script's REVOKE statements. The request queue must therefore be treated as readable and writable under those extension grants. A reusable credential must never be queued. The one-use token permits only the already-requested bounded drain, and expires or is consumed; it provides no lasting authority to a queue reader. Queue availability still depends on the managed extension privileges. Remove the obsolete static Vault token and worker hash environment setting after the one-use protocol is verified. Read actual ACLs and effective privileges when checking this boundary, rather than relying on a successful REVOKE command result.

Service-only RPCs provide the bounded worker protocol.

* `claim_account_erasures(p_limit integer default 10, p_lease_seconds integer default 120)` accepts limits 1–10 and leases 30–600 seconds. It uses row locks with `SKIP LOCKED`, claims due pending/retry jobs or expired processing leases, increments attempts and returns `[{id, customer_id, project_id, lease_token}]`.
* `complete_account_erasure(p_id uuid, p_lease_token uuid)` returns true only for a matching unexpired processing lease. It clears `customer_id`, marks complete and retains minimal timing/status metadata. Call it only after RevenueCat confirms the profile absent.
* `defer_account_erasure(p_id uuid, p_lease_token uuid, p_error_code text, p_retry_after integer)` requires the same active lease and accepts 5–86400 retry seconds. Allowed codes are `rate_limited`, `temporary`, `auth`, `project_mismatch`, `verification_pending`, `invalid_response` and `configuration`. It returns false for stale leases. No provider error body, token or personal information belongs in an error code.

A RevenueCat delete response queues provider work. The worker must verify completion through the non-creating v2 customer GET returning 404 after confirming project access. It must retain and retry incomplete jobs. Store subscription cancellation remains separate. The user's success message must distinguish the removed app account from scheduled purchase-profile removal. Repeated invocations and expired leases are safe because the provider operation is verified and idempotent.

RevenueCat's documented identity model treats merged aliases as one customer, and its staff confirms v2 customer deletion removes all aliases of that customer. Targeting the deterministic signed-in UUID therefore covers its merged aliases. It does not identify a separate, unmerged anonymous profile. Verification should include an alias-linked synthetic case when that fixture is available. Store receipts and later restore activity remain separate from deletion of the RevenueCat profile. [Identity model](https://www.revenuecat.com/docs/customers/identifying-customers#aliases) · [Official staff confirmation](https://community.revenuecat.com/general-questions-7/how-to-delete-aliases-to-prevent-people-to-amass-50-aliases-6733)

## Serialization and retry guarantees

Transitions and account commits lock the existing `auth.users` row with `FOR NO KEY UPDATE`; full account deletion uses `FOR UPDATE`. Other health writers take a conflicting `FOR SHARE` lock before reading current consent. Assignment/join mutations lock the target personal account before client relationships. This ordering covers fresh document inserts, in-flight photo metadata changes, summaries and assignments. A writer completed before begin becomes part of the frozen snapshot. A writer ordered after begin is refused.

Each re-grant rotates the UUID. The client must key its durable sync base/receipts by account and generation and require an explicit decision about uploading the selected device copy. A stale generation cannot become valid again. Ordinary CAS mismatch handling still applies within one generation.

PostgreSQL snapshots already started before withdrawal may finish an authorised read. Files or plans previously downloaded cannot be recalled. Previously issued storage capability URLs from older deployments need separate consideration at rollout; the consent-aware client does not issue them. Do not infer the absence of such URLs from the new policy alone.

## Local and hosted checks

For your own erasure scheduler, copy and configure
`scripts/prepare-account-erasure-scheduler.example.sql` and
`scripts/enable-account-erasure-scheduler.example.sql`. Replace every explicit
project placeholder with your own Supabase project reference or RevenueCat
project ID. The templates refuse to run with unchanged placeholders. Apply the
prepare script after the schema and worker deployment, test the worker against
your own project, then apply the enable script. Keep the resulting operator
configuration private. Never reuse another publisher's project identifiers.

Run the SQL and Edge regressions before staging.

```powershell
node --test tests/cloud-consent-sql.test.mjs tests/cloud-photo-remove.test.mjs tests/account-cas-sql.test.mjs tests/coach-sql.test.mjs tests/coach-access.test.mjs
```

PGlite exercises PostgreSQL permissions, legacy migration, generation rejection, frozen reads, owner isolation, withdrawal scope, idempotence and account deletion using synthetic rows. It uses one database connection and a model of the Storage operation helper. It does not prove hosted multi-connection or blob-storage behaviour.

Before applying SQL, verify the selected project provides `storage.allow_any_operation(text[])`. The documented operation names used here include `object.list`, `object.list_v2`, `object.delete`, `object.delete_many`, `object.get_authenticated`, `object.get_authenticated_info`, `object.head_authenticated_info`, `object.upload` and `object.upload_update`. Test actual upload, overwrite, authenticated download, recursive listing and HTTP removal against two synthetic accounts after deployment. Verify signed URL creation fails. Exercise concurrent begin versus CAS/photo upload, stale-generation rejection after re-grant, interrupted cleanup and scoped server-side row counts after finish. Preserve a separate user's sentinel data. Use a bounded verifier with disposable accounts and preserve the results separately from published source.

Storage policy operations and deletion requirements were checked against the current official references. The November 2026 TLS change concerns obsolete ciphers and does not alter this SQL contract. [Storage access control](https://supabase.com/docs/guides/storage/security/access-control) · [Storage operation helpers](https://supabase.com/docs/guides/storage/schema/helper-functions) · [Operation names](https://github.com/supabase/storage/blob/master/src/http/routes/operations.ts) · [HTTP object deletion](https://supabase.com/docs/guides/storage/management/delete-objects) · [TLS change](https://supabase.com/changelog/cbc-tls-ciphers-deprecated)

## Verify callable functions

Recheck function grants and the complete policy inventory after each schema change. Client-callable security-definer functions must enforce identity, ownership and consent generation themselves. Service-only Coach checks and `complete_photo_removal` must remain unavailable to anonymous or ordinary authenticated callers. Use the two-account and concurrency checks above to qualify a deployment.
