"""Build or verify the deterministic corresponding-source ZIP bundled with Iron Atlas.

Run without arguments to build; --check refuses missing, modified or stale output.
Only the reviewed source groups below and pack-mac.py's source groups are included.
"""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import runpy
import stat
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
ARCHIVE = "www/source/iron-atlas-source.zip"
MANIFEST = "www/source/manifest.json"
BINARY_EXTENSIONS = {".png", ".woff2", ".jar"}
EXECUTABLES = {"scripts/mac-simulator-check.sh", "android/gradlew"}
PUBLIC_EXCLUSIONS = {
    "customer-support-source/POLICY-REVIEW.md", "docs/store-submission.md",
    "docs/store-public-copy.md", "CAPTURE-NOTE.md", "qa/ios-simulator/CAPTURE-NOTE.md",
    "customer-site/.openai/hosting.json",
    "scripts/prepare-account-erasure-scheduler.sql", "scripts/enable-account-erasure-scheduler.sql",
}
ADDITIONAL_GROUPS = {
    "scripts": ["build-customer-site.mjs", "build-dependency-notices.mjs", "verify-source-release.mjs",
                "prepare-account-erasure-scheduler.example.sql", "enable-account-erasure-scheduler.example.sql"],
    "customer-support-source": ["index.html", "support.css", "worker-handler.mjs",
                                "privacy/index.html", "terms/index.html"],
    "customer-site": [".gitignore", ".openai/hosting.example.json", "scripts/build.mjs", "scripts/validate-artifact.mjs"],
    "android": [".gitignore", "build.gradle", "settings.gradle", "variables.gradle", "gradle.properties",
                "gradlew", "gradlew.bat", "gradle/wrapper/gradle-wrapper.jar", "gradle/wrapper/gradle-wrapper.properties"],
    "android/app": [".gitignore", "build.gradle", "proguard-rules.pro",
                    "src/main/AndroidManifest.xml", "src/main/java/uk/co/insomniait/ironatlas/MainActivity.java",
                    "src/test/java/com/getcapacitor/myapp/ExampleUnitTest.java",
                    "src/androidTest/java/com/getcapacitor/myapp/ExampleInstrumentedTest.java"],
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def mac_module(root):
    return runpy.run_path(str(root / "scripts/pack-mac.py"))


def source_file_names(root, mac):
    files = set(mac["source_file_names"](root, include_release=False))
    files.update((Path(folder) / name).as_posix() for folder, names in ADDITIONAL_GROUPS.items() for name in names)
    files.difference_update(PUBLIC_EXCLUSIONS)
    files.difference_update(mac["MACHINE_HELPER_FILES"])
    # Android resources are one directory deep; no generated assets/plugins or build trees.
    resources = root / "android/app/src/main/res"
    for folder in resources.iterdir():
        if not re.fullmatch(r"[a-z][a-z0-9-]*", folder.name):
            continue
        if folder.is_symlink():
            raise SystemExit("Source resource directory must not be a symbolic link.")
        if folder.is_dir():
            for path in folder.iterdir():
                if re.fullmatch(r"[a-z0-9_]+\.(?:xml|png)", path.name):
                    files.add(path.relative_to(root).as_posix())
    if ARCHIVE in files or MANIFEST in files:
        raise SystemExit("Source release cannot include its own generated output.")
    return sorted(files)


def source_snapshot(root=ROOT):
    root = root.resolve(strict=True)
    mac = mac_module(root)
    mac["public_config"]((root / "www/config.js").read_bytes())
    template = (root / "config.template.js").read_bytes()
    for field in ("supabaseUrl", "supabaseAnonKey", "revenuecatAppleKey", "revenuecatGoogleKey"):
        if not re.search(rb"(?m)^\s*" + field.encode() + rb":\s*'',", template):
            raise SystemExit("The template must contain unconfigured service settings.")
    snapshot = []
    for relative in source_file_names(root, mac):
        path = root / relative
        if path.resolve(strict=True) != path or not stat.S_ISREG(path.lstat().st_mode):
            raise SystemExit(f"Expected a regular source file at {relative}")
        data = path.read_bytes()
        if path.suffix not in BINARY_EXTENSIONS:
            mac["reject_privileged_credentials"](data, relative)
        snapshot.append((relative, data))
    return snapshot


def release_bytes(snapshot):
    out = io.BytesIO()
    # STORED makes the bytes independent of the host's zlib version.
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_STORED) as archive:
        for relative, data in snapshot:
            info = zipfile.ZipInfo("IronAtlas/" + relative, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | (0o755 if relative in EXECUTABLES else 0o644)) << 16
            archive.writestr(info, data)
    archive_bytes = out.getvalue()
    manifest = {"schemaVersion": 1, "archive": Path(ARCHIVE).name, "archiveSha256": digest(archive_bytes),
                "fileCount": len(snapshot),
                "files": {relative: digest(data) for relative, data in snapshot},
                "fileSizes": {relative: len(data) for relative, data in snapshot}}
    manifest_bytes = (json.dumps(manifest, indent=2, ensure_ascii=True) + "\n").encode("utf-8")
    return archive_bytes, manifest_bytes


def check_release(root=ROOT):
    snapshot = source_snapshot(root)
    expected_archive, expected_manifest = release_bytes(snapshot)
    for relative, expected in ((ARCHIVE, expected_archive), (MANIFEST, expected_manifest)):
        path = root / relative
        if not path.exists() or path.resolve() != path or not path.is_file() or path.read_bytes() != expected:
            raise SystemExit("Corresponding source is missing or stale. Run scripts/build-source-release.py before packaging.")
    return {"files": len(snapshot), "sha256": digest(expected_archive)}


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.parent.resolve() != path.parent or (path.exists() and (path.is_symlink() or not path.is_file())):
        raise SystemExit("Source release destination must not redirect elsewhere.")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(data)
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def build_release(root=ROOT):
    root = root.resolve(strict=True)
    snapshot = source_snapshot(root)
    archive, manifest = release_bytes(snapshot)
    atomic_write(root / ARCHIVE, archive)
    atomic_write(root / MANIFEST, manifest)
    # A concurrent source edit must fail rather than create a misleading release.
    return check_release(root)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Check both release files match every current source byte")
    args = parser.parse_args()
    result = check_release() if args.check else build_release()
    print(f"{result['files']} corresponding-source files verified. SHA-256 {result['sha256']}")
