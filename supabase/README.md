# Iron Atlas Coach backend

Coach uses the subscriber's Supabase user UUID as the RevenueCat App User ID on both stores. For each trainer setup, roster read, plan assignment or client joining by code, the Edge Function authenticates the caller and reads the trainer's current subscriptions from RevenueCat. A free client can join a subscribed trainer. A trainer who cancels retains access while RevenueCat reports the subscription still gives access. Expiry, refunds and transfers take effect on the next protected request once RevenueCat reflects the change.

## Configure a dedicated project

1. Apply the complete `supabase-setup.sql` in the dedicated Iron Atlas Supabase SQL editor. The transaction supports a fresh database and an upgrade from the original 1.2 schema. It preserves records, replaces the older trainer RPCs and limits direct table access. Deploy the function and updated app together when upgrading an existing install.
2. Use the same RevenueCat project for the iOS and Android apps. Attach their Coach subscription products to the `coach` entitlement. In the RevenueCat dashboard create a v2 secret API key scoped to this project with the permission `customer_information:subscriptions:read`. Put only the corresponding public SDK keys in the mobile configuration. [RevenueCat customer subscriptions](https://www.revenuecat.com/docs/api-v2/customer/resources) · [App User IDs](https://www.revenuecat.com/docs/customers/identifying-customers)
3. Set the following Edge Function secrets through the Supabase dashboard. The runtime supplies the project URL, publishable key and secret service key. [Supabase function secrets](https://supabase.com/docs/guides/functions/secrets)

   | Secret | Value |
   | --- | --- |
   | `REVENUECAT_PROJECT_ID` | The project identifier beginning with `proj` |
   | `REVENUECAT_V2_SECRET_KEY` | The server-only v2 key from step 2 |
   | `REVENUECAT_COACH_ENTITLEMENT` | Optional entitlement lookup key, default `coach`. Match the mobile setting. |
   | `COACH_SANDBOX_ACCOUNT_IDS` | Optional comma-separated Supabase UUIDs of dedicated store review and test accounts. All other accounts use production purchases. |

4. Deploy `coach-access` from this repository against the intended project. With an authenticated Supabase CLI use `supabase functions deploy coach-access --project-ref <iron-atlas-project-ref>`. Keep JWT verification enabled. The handler also validates the current user through the project's Auth service. [Supabase function authentication](https://supabase.com/docs/guides/functions/auth)
5. For TestFlight, Play license testing or store review, add dedicated confirmed trainer and client UUIDs to the sandbox list. Use synthetic training records for both. Sandbox clients can join sandbox trainers, and production clients can join production trainers. The app cannot select this setting. Configure Apple and Google store notifications in RevenueCat so it can observe renewals, refunds and other lifecycle changes promptly. [RevenueCat platform notifications](https://www.revenuecat.com/docs/platform-resources/server-notifications)

The endpoint returns HTTP 403 for an inactive subscription, 429 for more than 20 protected requests per account per minute, and 503 if it cannot check the provider or database. The client's disconnect and account deletion operations remain available independently of the subscription service.

## Verify before releasing

### Account document commits

Account writers use `commit_app_state(p_expected, p_docs)`. Both arguments are JSON objects with exactly the same touched keys. Accepted keys are `main`, the legacy `state`, and quarterly keys such as `log-2026q4`. Each desired value is a document object. Each expected value is the previously read document object, or JSON null if the document was absent. Empty maps are a valid no-op.

The function compares JSONB values and atomically commits every supplied document only when all bases match. It returns `{"applied":true}` on success or `{"applied":false}` without writes on a conflict. A client must fetch current documents and reconcile its durable pending changes after a conflict or an uncertain network response. Stored documents with untouched keys stay intact. Clearing a quarter uses an empty document such as `{"e":[]}`.

All commits serialize on the authenticated account row and lock existing touched records. Account deletion makes further commits fail, including with an unexpired old token. A DELETE/wipe of an existing document conflicts with a subsequent commit expecting its previous value. The client must clear its local bases and pending writes when wiping. An expected-null insert is still a valid new write after a completed wipe.

This pre-release backend update removes direct authenticated INSERT and UPDATE grants on `app_state`. Ship the CAS-aware client with the SQL update and refresh older debug installs. Older bulk-upsert clients will receive a permission error. Existing records are preserved when reapplying the full SQL baseline.

From the repository root, run `npm ci` and `node --test tests/account-cas-sql.test.mjs tests/coach-access.test.mjs tests/coach-sql.test.mjs`. These use synthetic provider responses and a temporary in-memory PostgreSQL instance with local Auth and Storage fixtures. PGlite checks stale-client interleavings on one connection. Before accepting the hosted update, issue two simultaneous authenticated HTTP commits using the same old base and verify one success and one conflict, including for a previously missing key.

On each platform, sign in to a dedicated confirmed test account, buy Coach, create its trainer code, join with a separate free client, load its roster, assign a plan and collect it as the client. Check cancellation during a paid period, renewal, expiry, refund, restoration and switching between two accounts using the stores' testing tools. Verify the correct account retains or loses roster access after each event. Then confirm a normal production account cannot use the test trainer's code or sandbox subscription.
