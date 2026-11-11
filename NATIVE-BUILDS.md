# Native builds

After changing any source, run `node scripts/build-dependency-notices.mjs` and `python3 scripts/build-source-release.py` (or the local Python 3 command) before Capacitor sync. The app bundles free corresponding source for the OpenGym-derived release. The native release check rejects a missing or stale source package; rebuild it and sync again whenever source changes.

Iron Atlas 1.2.0 uses the Apple bundle ID and Android application ID `uk.co.insomniait.ironatlas`. The initial native build numbers are both 1. If an earlier build has already been uploaded under that identifier, raise the corresponding number before archiving.

## MacinCloud and Xcode

1. Copy the project source and its npm lockfile to the Mac. Include the entire `ios/` source directory and `www/`. Dependency directories and Windows build products are regenerated on the Mac.
2. Install Node 22 or later and Xcode 26 or later with an iOS 26 or newer SDK. In Terminal, from the project root, run `npm ci`, `npm test`, `npm run core`, and `npx cap sync ios`. These commands prepare a Debug build with the development settings. Open `ios/App/App.xcodeproj` and run the App scheme on a simulator. Check the first-run flow and reopen a saved workout.
3. In the Xcode App target, select your own team in **Signing & Capabilities**. Verify the bundle ID and capabilities for **HealthKit** and **In-App Purchase**. On an iPhone, test camera, reminders, speech, sharing, and the optional body-weight write, including denying and revoking permissions. Inspect the archived app privacy report and confirm device backup exclusions for local health records.
4. Set the real iOS commercial service configuration in `www/config.js` as described in the main README. Run `npm run store:ios` to check settings, refresh the native files and open the project. Xcode needs `node` on its PATH or an absolute `NODE_BINARY` build setting. The Release build checks the copied web assets against the source.
5. Select **Any iOS Device (arm64)**, then **Product → Archive**. Use **Validate App** in Organizer and inspect its results. Use an internal TestFlight build and the store's sandbox purchases to check both paid tiers, restore, cancellation and account flows before choosing a public release. Manage any uploads and signing in the developer's own account.

## Android

Use JDK 21, the Android SDK Platform 36 and build tools 36. The app supports Android 8.0 (API 26) and above. Set `JAVA_HOME` and `ANDROID_HOME` for command-line builds. From the project root, run:

```powershell
npm ci
npm test
npm run core
npx cap sync android
.\android\gradlew.bat -p android :app:assembleDebug :app:bundleDebug :app:testDebugUnitTest
```

The generated APK and debug bundle are under `android/app/build/outputs/`. For a release, fill the real Android settings, run `npm run store:android`, then choose **Build → Generate Signed App Bundle** in Android Studio with the developer's upload key. Keep the key and credentials outside the project. Store test purchases and distribution need an active Google Play developer account.

## Native data access

The Android manifest removes the unused health permissions supplied by the health plug-in. Iron Atlas can write weight when a user opts in. The embedded Health Connect rationale is `www/privacypolicy.html`. Device transfers and Android cloud backups exclude private app storage. On iOS, the app excludes its WebKit and Application Support directories from device backups before starting the web view. Temporary shared files use the cache directory.

## Platform references

- [Capacitor 8 toolchain and deployment targets](https://capacitorjs.com/docs/updating/8-0)
- [Apple SDK submission requirements](https://developer.apple.com/news/upcoming-requirements/?id=04282026a)
- [Google Play target API requirements](https://developer.android.com/google/play/requirements/target-sdk)
- [Health plug-in setup and health permissions](https://github.com/Cap-go/capacitor-health)

## Simulator workflow checks

Run `python3 qa/ios-simulator/run.py "/path/to/Debug-iphonesimulator/App.app" --output "/path/to/new-results"` on the Mac. The runner creates dedicated simulators and records the interaction results and screenshot checksums. These checks do not establish a signed device release or store approval.
