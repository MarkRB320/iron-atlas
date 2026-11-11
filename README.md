# Iron Atlas

**Development status:** store qualification is ongoing. The public source repository is [MarkRB320/iron-atlas](https://github.com/MarkRB320/iron-atlas).

Iron Atlas is licensed under GNU AGPL v3 with the retained app-store additional permission. It incorporates adapted openGym code for plate loading, one-rep-max estimates and CSV exports. See [NOTICE.md](NOTICE.md) for attribution and [SOURCE.md](SOURCE.md) for the free corresponding source and build instructions. Restricted third-party exercise media is not included.

Iron Atlas 1.2.0 is a Capacitor app for iPhone, iPad and Android. The retail bundle identifier is `uk.co.insomniait.ironatlas`. The web app, Three.js, fonts and workout library are bundled in `www/`. Guest workouts, measurements and progress photos are stored on the device. Accounts add backup and trainer connections. Customer support is **mark@insomnia-it.co.uk**.

## Run the project

Use Node 22 or later and the checked-in lockfile.

```sh
npm ci
npm test
```

Open `www/index.html` for the offline browser preview. The browser preview unlocks paid features for development. Native builds start on the free plan and unlock features only after the store returns an active entitlement. Run `npm run sync` after changing web assets on a machine with both platforms' prerequisites. For a single platform use `npm run core` followed by `npx cap sync android` or `npx cap sync ios`. The Android and iOS projects already exist in this folder.

## Set up the services

1. Use a dedicated Iron Atlas Supabase project. Apply `supabase-setup.sql` and follow `supabase/README.md` to configure and deploy the Coach entitlement function. The app uses the public project URL and publishable key. Store privileged credentials in the function's secret configuration.
2. Deploy the account portal on HTTPS, configure its redirect in Supabase and test the confirmation and recovery emails. The portal provides an account deletion path outside the app. Follow `docs/account-portal.md`.
3. Create Iron Atlas products in App Store Connect and Play Console and connect the two store apps to one dedicated RevenueCat project. Use the offerings below. Grant only the server permissions specified in `supabase/README.md`.
4. Fill in `www/config.js` using the public settings from those services and the published policy and portal URLs. The config is copied into the binaries and is readable by customers. Keep the Apple and Google server credentials, service role and RevenueCat secret keys outside it.
5. Exercise signup, confirmation, recovery, cloud backup, restore, deletion and two separate trainer/client accounts in an isolated test environment. Test subscription status and restoration using each store's test environment.

## Products and offerings

| Offering | Packages | Access |
| --- | --- | --- |
| `default` | Monthly, Annual, Lifetime | `premium` |
| `coach` | Monthly, Annual | `coach` and `premium` |

The recovered catalogue uses `ia_premium_monthly`, `ia_premium_annual`, `ia_premium_lifetime`, `ia_coach_monthly` and `ia_coach_annual` on Apple. Put the recurring options in the same subscription group with Coach above Premium. Lifetime is a separate non-consumable. On Play, map the corresponding base plans and one-time product to the RevenueCat packages. Confirm prices, territories and introductory offers in the respective store consoles. Keep the existing catalogue if store products have already been registered.

Retail paywalls use the price returned for the selected store package. The original UK price proposal remains in `config.template.js` for preview and planning. Real trainer setup, client reads, client joins and plan assignment require the server's subscription check. Coach summaries exclude progress photos and body measurements.

## Build and qualify

```sh
node scripts/check-store-config.mjs ios
node scripts/check-store-config.mjs android
```

The checks list any missing public configuration. A passing check confirms the shape of the settings. Checkout, signing and service connections still require an actual environment.

- **Apple.** On the hosted Mac run `npm ci` and `npm run store:ios`. Select the correct Apple team in Xcode and verify the bundle ID, build number, In-App Purchase and HealthKit capabilities. Test in Simulator and on an iPhone. Archive the release configuration and test the processed build using TestFlight.
- **Google.** Use `npm run store:android`. In Android Studio build a signed release App Bundle using the owner's upload key. Test the Play-delivered build on an internal track, including purchase, restore and subscription changes.
- **Before submission.** Confirm the public support, privacy, terms and account deletion resources, the stores' privacy and health declarations, real device screenshots and reviewer access. Complete the paid-app agreements and the store's tax and bank setup in the publisher account.

The automated tests use synthetic data. Device signing, processed store builds, live service deployment and actual sandbox transactions are separate verification steps.
