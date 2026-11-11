# Iron Atlas notices

Copyright (C) 2026 Mark Evans trading as Insomnia I.T. Systems.
Iron Atlas incorporates modified code from openGym, Copyright (C) 2026 Duarte Santos.

## Licence

The combined Iron Atlas application and its original supporting service source are
licensed under GNU Affero General Public License version 3.0 (AGPL-3.0-only), with
the additional app-store permission below. See LICENSE for the complete text.
Existing third-party components retain their own notices and licences.
This release does not grant rights to use another project's trademarks or imply endorsement.

## Modified openGym code — 11 November 2026

Upstream: https://github.com/DuarteSantos8/openGym
Pinned revision: 50ab7f24e3c4ee70e7f26b3beb426f571e03414b

www/opengym/training-tools.js adapts selected code from:
- frontend/src/lib/plates.js: plate denominations and finite-inventory loading algorithms.
- frontend/src/lib/onerm.js: named one-repetition-maximum formulas.
- frontend/src/lib/export-csv.js: CSV escaping and export-column conventions.

Changes include a standalone browser/CommonJS API, explicit input limits and
validation, Iron Atlas exercise-log adapters, user-selected units, and a separate
Iron Atlas user interface. No OpenGym backend, exercise catalogue, media, account
credentials or user records are included. The full upstream notice is preserved
in www/licenses/opengym-NOTICE.txt for attribution and provenance; sections about
components not included here do not indicate those components are distributed.

## Upstream app-store additional permission (verbatim)

As an additional permission under section 7 of the AGPL v3.0, the copyright holder permits
distribution of the openGym mobile application through app store platforms (such as the
Apple App Store and Google Play) whose terms of service would otherwise be incompatible
with the AGPL, provided the corresponding source code remains available under the AGPL at
the project repository. This permission applies to the distribution channel only and does
not otherwise limit the license.

For the copyright in Iron Atlas owned by Mark Evans, the same additional
permission applies to distributing the Iron Atlas application through those
app-store platforms. All AGPL source-availability duties remain in force.
The permission above is retained for the incorporated openGym code.

## Third-party components

- Three.js r128, Copyright 2010–2021 Three.js Authors — MIT. See www/licenses/three.txt.
- Plus Jakarta Sans and Unbounded font software — SIL Open Font License 1.1.
  See the corresponding files in www/licenses.
- Capacitor and plugin versions are pinned in package-lock.json. Their own
  licences remain applicable; see SOURCE.md for dependency source retrieval.
- No Gym visual images or animations are distributed. Iron Atlas renders its
  existing figures and exercise demonstrations from the application's own code.

## Warranty and source

This program is distributed without any warranty, to the extent permitted by
applicable law. Statutory consumer rights and separately agreed service
obligations are not excluded. See LICENSE, sections 15–17.

The app's Account → Open-source licences and source code controls
provide the licence and a free copy of the corresponding source without a paid
subscription. SOURCE.md describes builds and source-package verification.

