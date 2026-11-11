# Iron Atlas corresponding source

This directory is the preferred editable source for Iron Atlas 1.2.0, including
its OpenGym integration dated 11 November 2026. See LICENSE and NOTICE.md.
No purchase, sign-in or developer account is required to receive this source.
The public project repository is [MarkRB320/iron-atlas](https://github.com/MarkRB320/iron-atlas).
Development and store qualification are ongoing.

## What is included

The source package includes the browser application, editable native iOS and
Android project files, app artwork, backend functions and SQL, account portal and
support-site source, dependency lockfile, build/verification scripts and tests.
The public configuration is the configuration shipped to app users. It contains
no signing private keys, service-role credentials, customer data or server-only
secrets. Those are deployment-specific and are not needed to modify the program.

The archive deliberately excludes generated native web copies, node_modules,
build caches, logs, credentials, internal review/verification records, machine-specific
SSH transport and credential-provisioning tools, unrelated workspace files, and itself.
The generic local build scripts and their tests remain included. Use your own
signing credentials through Xcode or Android Studio when building for a device.
Capacitor recreates its generated native files during sync.

## Build and modify

Prerequisites: Node.js 22 or later, npm, Python 3.10 or later, and for Android
JDK 21/Android SDK or for iOS a Mac with Xcode 26 or later. Consult NATIVE-BUILDS.md
and each pinned dependency's platform requirements.

1. Extract the source zip into an empty directory.
2. Run `npm ci`. The exact npm dependency versions and integrity hashes are
   recorded in package-lock.json. npm obtains their source distributions from
   the public npm registry; no Iron Atlas account is needed.
3. Run `npm test` and `node scripts/build-dependency-notices.mjs`.
4. Run `python3 scripts/build-source-release.py` (use `python` where appropriate).
   Rebuild the source package whenever modifying files that will be distributed.
5. Run `npm run core`, then `npx cap sync android` or `npx cap sync ios`.
6. Open the generated native project, select your own signing identity, and
   build. For a local browser preview, serve www with a static HTTP server.
   The web preview exposes the training UI without a store purchase.

To operate your own service, copy config.template.js to www/config.js and fill
your own public project/SDK settings. Deploy supabase-setup.sql and the functions
as explained in supabase/README.md. Publish the account/support site from
customer-support-source with scripts/build-customer-site.mjs. Supply your own
legal/publisher details and keep service credentials in server secrets.
For a Sites deployment, copy customer-site/.openai/hosting.example.json to
customer-site/.openai/hosting.json and set the project ID for your own site before
running customer-site/scripts/build.mjs. The operator's hosting configuration is
excluded from the public source.
The original publisher's store products and signing identities are not transferable.

## Dependency source and licences

The unmodified public dependencies are identified by package-lock.json, including
their exact download addresses and integrity hashes. `npm ci --ignore-scripts`
retrieves them for inspection. Their packages include the relevant licences.
Capacitor and most plugins use MIT; @capgo/capacitor-health uses MPL-2.0 and PGlite
uses Apache-2.0. Review each included dependency's own licence when redistributing.

www/three.min.js is the unmodified Three.js r128 browser build. Its editable
upstream source is https://github.com/mrdoob/three.js/tree/r128 and the corresponding
public npm source package is https://registry.npmjs.org/three/-/three-0.128.0.tgz.
Its MIT licence is bundled in www/licenses/three.txt.
The fonts and their SIL Open Font License texts are bundled too.

OpenGym source was pinned at
https://github.com/DuarteSantos8/openGym/tree/50ab7f24e3c4ee70e7f26b3beb426f571e03414b.
The portions actually incorporated remain editable in
www/opengym/training-tools.js, with upstream file names and modification notes.
The complete AGPL and original upstream NOTICE are included.

## Reproducibility and source access

`python3 scripts/build-source-release.py` creates
www/source/iron-atlas-source.zip and its SHA-256 manifest. The archive has stable
file order and timestamps. `python3 scripts/build-source-release.py --check`
rejects missing or stale source packages. Its manifest records the exact inputs.
This is source reproducibility, not a claim that signed native binaries are
bit-for-bit reproducible across different toolchains and signing identities.

The application offers the source archive from its bundled files, including
offline through the platform's share/save interface. Source access is free and
does not pass through the Premium or Coach paywall. The public repository is
https://github.com/MarkRB320/iron-atlas. Publish the same corresponding source there
and link it from the support site before store distribution; retain archives for
every version made available.
Changes to source require a new archive and fresh native verification.

## Distribution terms

AGPL grants rights to study, modify and redistribute the software, subject to
its conditions. Charges for store delivery, subscriptions and hosted services
do not remove these rights. A derivative distributor must provide corresponding
source for its own changes and preserve notices. Account access, hosted service
quotas, store purchases, the publisher name and signing keys are distinct from
the source-code licence. No Gym visual media rights are granted.

