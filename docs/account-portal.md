# Hosting the Iron Atlas account portal

Use your own HTTPS host, Supabase project and transactional email sender. Keep SMTP credentials in the server configuration. Test email delivery and recovery links before accepting accounts.

## Portal deployment

Serve `www/account/` from a public HTTPS web server with its four files together. Serve
`www/config.js` one directory above it. The public configuration must use the same Iron Atlas
Supabase URL and publishable or legacy anon key as the app. Use a dedicated origin or a trusted
site where others cannot publish scripts under the same origin.

1. Set `passwordResetUrl` to the exact public URL of this portal, including any trailing slash.
   Set the same value in both the hosted config and the app build. No credentials or URL fragment
   belong in this URL.
2. Add that exact URL to the Iron Atlas project's **Authentication → URL Configuration → Redirect URLs**.
   Use the standard Supabase recovery email confirmation link and implicit flow. A verified
   link returns to the portal with `type=recovery` and an access token in the fragment.
3. Apply the project's reviewed database and Storage policies before accepting users.
   In Google Play Console, provide the public portal URL for account deletion.
4. Verify from the public URL using dedicated test accounts. Request a reset from the app,
   open the email, choose a password and sign in again. Check an expired link and a wrong password.
   Confirm that cancelling deletion preserves data. Then delete a test account with photos from two
   devices and verify its sign-in, records, trainer links, share codes and photo objects are gone.
   Confirm a second account still signs in and retains its own photos.

Configure the host to serve the account page without caching, add a `Content-Security-Policy:
frame-ancestors 'none'` response header to prevent framing, and disable third-party scripts,
analytics, caching proxies that rewrite HTML, and service workers on this page. Never log
authorization headers, email link credentials, request bodies or passwords.

The public page performs a fresh email/password sign-in before deletion and asks for explicit
confirmation. It uses the member's own Storage access to empty their folder before requesting
database deletion. A failed step can be retried. A web request cannot erase an offline copy on
another device or cancel an Apple or Google subscription.

See [Supabase password recovery](https://supabase.com/docs/guides/auth/passwords) and
[redirect URL configuration](https://supabase.com/docs/guides/auth/redirect-urls).
