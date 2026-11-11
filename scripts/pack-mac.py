"""Build a reproducible Mac source archive: python3 scripts/pack-mac.py /path/to/source.tar.gz"""

import argparse
import base64
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import runpy
import tarfile
import tempfile
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parent.parent
CHECK = "scripts/mac-simulator-check.sh"
# Local transport/provisioning tools are not needed to build from public source.
# They remain available in the private Mac transfer used by this checkout.
MACHINE_HELPER_FILES = (
    "scripts/run-mac-appstore-build.cjs", "scripts/receive-mac-appstore-build.py",
    "scripts/install-mac-signing-assets.cjs", "scripts/install-mac-signing-assets.py",
    "tests/mac-transfer.test.cjs", "tests/mac-signing-assets.test.cjs",
)
# Explicit source manifest. Capacitor sync recreates the iOS web bundle and plugin files.
GROUPS = {
    "": [
        ".gitignore", "README.md", "NATIVE-BUILDS.md", "package.json", "package-lock.json",
        "capacitor.config.json", "config.template.js", "supabase-setup.sql", "LICENSE", "NOTICE.md", "SOURCE.md",
    ],
    "assets": ["icon.png", "icon-background.png", "icon-foreground.png", "splash.png", "splash-dark.png"],
    "www": ["index.html", "config.js", "three.min.js", "privacypolicy.html"],
    "www/account": ["index.html", "account.css", "account-tools.js", "cloud-sync.js", "cloud-backup.js", "moderation.js", "portal.js"],
    "www/opengym": ["training-tools.js", "provenance.json"],
    "www/source": ["iron-atlas-source.zip", "manifest.json"],
    "www/fonts": ["plus-jakarta-sans.woff2", "unbounded.woff2"],
    "www/licenses": ["plus-jakarta-sans.txt", "unbounded.txt", "three.txt"],
    "docs": ["account-portal.md", "cloud-consent.md", "moderation.md", "store-public-copy.md", "store-submission.md"],
    "scripts": [
        "check-store-config.mjs", "verify-native-release.mjs", "mac-simulator-check.sh", "mac-appstore-build.mjs", "pack-mac.py",
        "run-mac-appstore-build.cjs", "receive-mac-appstore-build.py",
        "install-mac-signing-assets.cjs", "install-mac-signing-assets.py",
        "build-source-release.py",
        "cloud-consent-preflight.sql", "prepare-account-erasure-scheduler.sql", "enable-account-erasure-scheduler.sql",
    ],
    "supabase": ["config.toml", "README.md"],
    "supabase/functions/coach-access": ["handler.mjs", "index.ts"],
    "supabase/functions/cloud-photo-remove": ["handler.mjs", "index.ts"],
    "supabase/functions/account-erasure": ["handler.mjs", "index.ts"],
    "tests": [
        "account-session.test.cjs", "account-tools.test.cjs", "billing.test.mjs",
        "coach-access.test.mjs", "coach-sql.test.mjs", "coach-delivery.test.mjs", "shared-plans.test.mjs",
        "account-cas-sql.test.mjs", "cloud-sync.test.cjs",
        "cloud-backup.test.cjs", "cloud-consent-sql.test.mjs", "cloud-photo-remove.test.mjs",
        "photo-generation.test.cjs", "sharing-consent.test.mjs", "store-config.test.mjs", "account-erasure.test.mjs",
        "mac-appstore-build.test.mjs",
        "mac-transfer.test.cjs",
        "mac-signing-assets.test.cjs",
        "moderation.test.cjs", "moderation-ui.test.cjs", "moderation-sql.test.mjs",
    ],
    "qa/ios-simulator": [
        "run.py", "QAHost.swift", "IronAtlasUITests.swift", "IronAtlasQA.xcodeproj/project.pbxproj",
        "IronAtlasQA.xcodeproj/xcshareddata/xcschemes/IronAtlasQA.xcscheme",
    ],
    "ios": [".gitignore", "debug.xcconfig"],
    "ios/App/App.xcodeproj": [
        "project.pbxproj", "project.xcworkspace/xcshareddata/IDEWorkspaceChecks.plist",
    ],
    "ios/App/CapApp-SPM": ["Package.swift", "Sources/CapApp-SPM/CapApp-SPM.swift", ".gitignore", "README.md"],
    "ios/App/App": [
        "AppDelegate.swift", "SceneDelegate.swift", "App.entitlements", "Info.plist", "PrivacyInfo.xcprivacy",
        "Base.lproj/Main.storyboard", "Base.lproj/LaunchScreen.storyboard", "Assets.xcassets/Contents.json",
        "Assets.xcassets/AppIcon.appiconset/Contents.json", "Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png",
    ],
    "ios/App/App/Assets.xcassets/Splash.imageset": [
        "Contents.json", *[f"Default@{size}x~universal~anyany{suffix}.png"
                           for size in (1, 2, 3) for suffix in ("", "-dark")],
    ],
}


def public_config(data):
    def value(field):
        match = re.search(rb"(?m)^\s*" + field.encode() + rb":\s*'([^']*)',", data)
        if not match:
            raise SystemExit(f"Missing public configuration field {field}")
        return match.group(1).decode("utf-8")

    url, key = value("supabaseUrl"), value("supabaseAnonKey")
    if bool(url) != bool(key):
        raise SystemExit("Supabase public URL and key must be configured together.")
    if url:
        parsed = urlsplit(url)
        if (parsed.scheme != "https" or not re.fullmatch(r"[a-z]{20}\.supabase\.co", parsed.netloc)
                or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
            raise SystemExit("Unexpected public Supabase URL.")
        if not key.startswith("sb_publishable_"):
            try:
                claims = json.loads(base64.urlsafe_b64decode(key.split(".")[1] + "==="))
            except (ValueError, IndexError):
                raise SystemExit("The supplied Supabase key is not a public key.")
            if claims.get("role") != "anon" or claims.get("ref") != parsed.hostname.split(".")[0]:
                raise SystemExit("The supplied Supabase key is not an anon key for this project.")
    for field, prefix in (("revenuecatAppleKey", "appl_"), ("revenuecatGoogleKey", "goog_")):
        key = value(field)
        if key and not key.startswith(prefix):
            raise SystemExit("Only public RevenueCat platform keys can be packaged.")


def reject_privileged_credentials(data, relative):
    # Require PEM body material so validator code can mention a header safely.
    pem = (rb"-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----(?:\s|\\r|\\n)+"
           rb"(?:Proc-Type:[^\r\n]+[\r\n]+(?:DEK-Info:[^\r\n]+[\r\n]+)?\s*)?"
           rb"(?:[A-Za-z0-9+/=]|\s|\\r|\\n){64,}")
    pattern = pem + rb"|\bsb_secret_[\w-]{16,}|\bgh[pso]_[\w]{24,}|\bAKIA[A-Z0-9]{16}\b"
    if re.search(pattern, data):
        raise SystemExit(f"Possible privileged credential in {relative}")
    for token in re.findall(rb"\beyJ[\w-]+\.(eyJ[\w-]+)\.[\w-]+", data):
        try:
            claims = json.loads(base64.urlsafe_b64decode(token + b"==="))
        except ValueError:
            continue
        if claims.get("role") == "service_role":
            raise SystemExit(f"Privileged JWT in {relative}")


def source_file_names(root=ROOT, include_release=True):
    files = {(Path(folder) / name).as_posix() for folder, names in GROUPS.items() for name in names
             if include_release or folder != "www/source"}
    # Bounded, immediate-child rules also pick up newly added notices and tests.
    for folder, extensions in (("www/licenses", (".txt", ".html", ".json")),
                               ("tests", (".test.cjs", ".test.mjs"))):
        for path in (root / folder).iterdir():
            if any(path.name.endswith(extension) for extension in extensions):
                files.add(path.relative_to(root).as_posix())
    for note in ("CAPTURE-NOTE.md", "qa/ios-simulator/CAPTURE-NOTE.md"):
        if (root / note).exists():
            files.add(note)
    return sorted(files)


def source_snapshot():
    # An archive with stale corresponding source must never reach a native build.
    source_release = runpy.run_path(str(ROOT / "scripts/build-source-release.py"))
    source_release["check_release"](ROOT)
    template = (ROOT / "config.template.js").read_bytes()
    for field in ("supabaseUrl", "supabaseAnonKey", "revenuecatAppleKey", "revenuecatGoogleKey"):
        if not re.search(rb"(?m)^\s*" + field.encode() + rb":\s*'',", template):
            raise SystemExit("The template must contain unconfigured service settings.")
    public_config((ROOT / "www/config.js").read_bytes())
    # Transfer the full corresponding source too, so the same gate can run on
    # the Mac without missing Android or support-site inputs.
    files = [relative for relative, _ in source_release["source_snapshot"](ROOT)]
    files.extend(relative for relative in MACHINE_HELPER_FILES if (ROOT / relative).is_file())
    files.extend(["www/source/iron-atlas-source.zip", "www/source/manifest.json"])
    files.sort()
    snapshot = []
    for relative in files:
        path = ROOT / relative
        if path.resolve(strict=True) != path or not path.is_file():
            raise SystemExit(f"Expected a regular source file at {relative}")
        data = path.read_bytes()
        if path.suffix not in (".png", ".woff2", ".zip", ".jar"):
            reject_privileged_credentials(data, relative)
        if relative == CHECK and (b"\r" in data or not data.startswith(b"#!/bin/bash\n")):
            raise SystemExit(f"{CHECK} must be an LF-terminated Bash script.")
        snapshot.append((relative, data))
    return snapshot


def pack(destination):
    if destination.is_relative_to(ROOT) or not destination.name.endswith(".tar.gz"):
        raise SystemExit("Choose a .tar.gz destination outside the project.")
    snapshot = source_snapshot()
    digests = {}
    with tempfile.NamedTemporaryFile(dir=destination.parent, suffix=".tmp", delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        with tmp_path.open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=0) as gz:
            with tarfile.open(fileobj=gz, mode="w", format=tarfile.USTAR_FORMAT) as archive:
                for relative, data in snapshot:
                    member = tarfile.TarInfo("IronAtlas/" + relative)
                    member.size = len(data)
                    member.mode = 0o755 if relative == CHECK else 0o644
                    archive.addfile(member, io.BytesIO(data))
                    digests[member.name] = hashlib.sha256(data).digest()
        with tarfile.open(tmp_path, "r:gz") as archive:
            members = archive.getmembers()
            if [m.name for m in members] != list(digests):
                raise SystemExit("Unexpected archive contents.")
            for member in members:
                if not member.isfile() or hashlib.sha256(archive.extractfile(member).read()).digest() != digests[member.name]:
                    raise SystemExit(f"Verification failed for {member.name}")
        os.replace(tmp_path, destination)
    finally:
        tmp_path.unlink(missing_ok=True)
    print(f"{len(snapshot)} source files verified. SHA-256 {hashlib.sha256(destination.read_bytes()).hexdigest()}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path, nargs="?")
    parser.add_argument("--check", action="store_true", help="Validate the source allowlist without writing an archive")
    args = parser.parse_args()
    if args.check:
        if args.destination:
            parser.error("--check does not take a destination")
        print(f"{len(source_snapshot())} source files passed allowlist and credential checks.")
    else:
        if not args.destination:
            parser.error("supply an archive destination or --check")
        pack(args.destination.resolve())
