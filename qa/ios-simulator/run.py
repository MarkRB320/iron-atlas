#!/usr/bin/env python3
"""Run the standalone XCTest targets against an existing Iron Atlas simulator app."""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import plistlib
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import uuid

APP_ID = "uk.co.insomniait.ironatlas"
RUNNER_ID = "uk.co.insomniait.ironatlas.qa.ui.xctrunner"
SCREEN_NAMES = ("01-muscle-atlas", "02-training-plans", "03-guided-workout")
STORE_SIZES = {
    "iphone": {(1260, 2736), (1290, 2796), (1320, 2868), (1284, 2778), (1242, 2688)},
    "ipad": {(2064, 2752), (2048, 2732)},
}


def command(*args, timeout=120, check=True):
    finished = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if check and finished.returncode:
        detail = (finished.stderr or finished.stdout).strip()[-1800:]
        raise RuntimeError(f"{args[0]} {args[1]} failed ({finished.returncode}): {detail}")
    return finished


def sim(*args, **options):
    return command("xcrun", "simctl", *args, **options)


def save(path, data):
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def new_device(kind, runtimes, device_types):
    # Prefer App Store Connect's largest supported display for each family.
    # simctl create validates the device/runtime pairing; running user devices
    # are never candidates for installation, shutdown, or deletion.
    for runtime in runtimes:
        candidates = [t for t in device_types if t["name"].startswith("iPhone" if kind == "iphone" else "iPad")]
        if kind == "iphone":
            candidates.sort(key=lambda t: ("Pro Max" in t["name"], "Plus" in t["name"],
                tuple(map(int, re.findall(r"\d+", t["name"])))), reverse=True)
        else:
            candidates.sort(key=lambda t: ("13-inch" in t["name"] or "12.9-inch" in t["name"],
                "Pro" in t["name"], tuple(map(int, re.findall(r"\d+", t["name"])))), reverse=True)
        for device in candidates:
            attempt = sim("create", f"IronAtlas-QA-{kind}-{uuid.uuid4().hex[:8]}",
                          device["identifier"], runtime["identifier"], check=False)
            if attempt.returncode == 0:
                udid = str(uuid.UUID(attempt.stdout.strip())).upper()
                return udid, device["name"], runtime["name"]
    raise RuntimeError(f"No compatible {kind} simulator device type and iOS runtime are installed")


def named_exports(node):
    if isinstance(node, list):
        for entry in node:
            yield from named_exports(entry)
    elif isinstance(node, dict):
        if isinstance(node.get("exportedFileName"), str):
            yield node
        for value in node.values():
            yield from named_exports(value)


def export_screens(folder, udid, kind, result):
    bundle = folder / "UITests.xcresult"
    exported = folder / "attachments"
    out = folder / "screenshots"
    out.mkdir(exist_ok=True)
    if bundle.is_dir():
        export = command("xcrun", "xcresulttool", "export", "attachments", "--path", str(bundle),
                         "--output-path", str(exported), timeout=180, check=False)
        result["attachment_export_exit"] = export.returncode
        if export.returncode:
            (folder / "attachment-export.log").write_text(export.stderr + export.stdout)
    sources = {}
    manifest = exported / "manifest.json"
    if manifest.is_file():
        for entry in named_exports(json.loads(manifest.read_text())):
            suggested = entry.get("suggestedHumanReadableName", "") + " " + entry["exportedFileName"]
            match = next((name for name in SCREEN_NAMES if name in suggested), None)
            source = exported / Path(entry["exportedFileName"]).name
            if match and source.is_file():
                sources[match] = source
    for name in SCREEN_NAMES:
        if name not in sources and exported.is_dir():
            matches = list(exported.glob(f"*{name}*.png"))
            if matches:
                sources[name] = matches[0]
    container = sim("get_app_container", udid, RUNNER_ID, "data", check=False)
    if container.returncode == 0:
        docs = Path(container.stdout.strip()) / "Documents" / "IronAtlasQA"
        for name in SCREEN_NAMES:
            if name not in sources and (docs / (name + ".png")).is_file():
                sources[name] = docs / (name + ".png")
    result["screenshots"] = []
    for name in SCREEN_NAMES:
        if name not in sources:
            continue
        # Preserve the UI picture at native resolution. An opaque renderer
        # should already produce RGB. Convert just the encoding if UIKit
        # included an unused alpha channel.
        target = out / (name + ".png")
        shutil.copyfile(sources[name], target)
        raw = target.read_bytes()
        if raw[:8] != b"\x89PNG\r\n\x1a\n":
            raise ValueError(f"Not a PNG screenshot: {name}")
        width, height, depth, color = struct.unpack(">IIBB", raw[16:26])
        if color not in (0, 2, 3):
            raise ValueError(f"{name} has alpha; retain the attachment for review before store use")
        result["screenshots"].append({"file": f"screenshots/{target.name}", "width": width,
            "height": height, "depth": depth, "png_color_type": color,
            "large_store_display_size": (width, height) in STORE_SIZES[kind],
            "sha256": hashlib.sha256(raw).hexdigest()})
    return len(result["screenshots"])


def run_device(kind, folder, app, runtimes, types, derived):
    folder.mkdir()
    udid = None
    result = {"status": "failed"}
    try:
        udid, model, runtime = new_device(kind, runtimes, types)
        result.update(udid=udid, model=model, runtime=runtime)
        print(f"{kind}: {model}, {runtime}, {udid}", flush=True)
        sim("boot", udid)
        sim("bootstatus", udid, "-b", timeout=480)
        result["status_bar_exit"] = sim("status_bar", udid, "override", "--time", "9:41",
            "--batteryState", "charged", "--batteryLevel", "100", check=False).returncode
        sim("install", udid, str(app), timeout=180)
        args = ["xcodebuild", "-project", str(Path(__file__).resolve().with_name("IronAtlasQA.xcodeproj")),
                "-scheme", "IronAtlasQA", "-configuration", "Debug", "-destination", f"id={udid}",
                "-parallel-testing-enabled", "NO", "-maximum-concurrent-test-simulator-destinations", "1",
                "-resultBundlePath", str(folder / "UITests.xcresult"), "-derivedDataPath", str(derived),
                "CODE_SIGNING_ALLOWED=NO", "CODE_SIGNING_REQUIRED=NO", "test"]
        with (folder / "xcodebuild.log").open("w") as log:
            run = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, timeout=1200)
        result["xcodebuild_exit"] = run.returncode
        if (folder / "UITests.xcresult").is_dir():
            summary = command("xcrun", "xcresulttool", "get", "test-results", "summary",
                              "--path", str(folder / "UITests.xcresult"), check=False)
            if summary.returncode == 0:
                (folder / "test-summary.json").write_text(summary.stdout)
                metrics = json.loads(summary.stdout)
                result["total_tests"] = metrics.get("totalTestCount", 0)
                result["passed_tests"] = metrics.get("passedTests", 0)
                result["failed_tests"] = metrics.get("failedTests", 0)
        n = export_screens(folder, udid, kind, result)
        if run.returncode != 0 or result.get("passed_tests", 0) != 1 or n != len(SCREEN_NAMES):
            raise RuntimeError("The UI test or capture set is incomplete. See xcodebuild.log and UITests.xcresult.")
        result["status"] = "passed"
    except Exception as exc:
        result["error"] = str(exc)
        if udid:
            # A diagnostic relaunch is separate from passing an XCTest flow.
            launch = sim("launch", udid, APP_ID, check=False)
            result["diagnostic_launch_exit"] = launch.returncode
            if launch.returncode == 0:
                import time
                time.sleep(3)
                sim("io", udid, "screenshot", str(folder / "diagnostic-relaunch.png"), check=False)
    finally:
        if udid:
            result["shutdown_exit"] = sim("shutdown", udid, check=False).returncode
            result["delete_exit"] = sim("delete", udid, check=False).returncode
        save(folder / "receipt.json", result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--only", choices=("iphone", "ipad"))
    opts = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("Run on the Mac with the existing simulator build.")
    app = opts.app.expanduser().resolve()
    info = plistlib.loads((app / "Info.plist").read_bytes())
    if info.get("CFBundleIdentifier") != APP_ID or "iPhoneSimulator" not in info.get("CFBundleSupportedPlatforms", []):
        parser.error("Expected an Iron Atlas iOS Simulator .app.")
    out = opts.output.expanduser().resolve()
    out.mkdir(parents=True, exist_ok=False)
    receipt = {"started_utc": dt.datetime.now(dt.timezone.utc).isoformat(), "app_id": APP_ID,
               "version": info.get("CFBundleShortVersionString"), "build": info.get("CFBundleVersion"),
               "html_sha256": hashlib.sha256((app / "public" / "index.html").read_bytes()).hexdigest(),
               "xcode": command("xcodebuild", "-version").stdout.strip(), "devices": {}}
    save(out / "receipt.json", receipt)
    all_runs = json.loads(sim("list", "runtimes", "-j").stdout)["runtimes"]
    runtimes = sorted((r for r in all_runs if r.get("isAvailable") and ".iOS-" in r["identifier"]),
                      key=lambda r: tuple(map(int, re.findall(r"\d+", r["version"]))), reverse=True)
    types = json.loads(sim("list", "devicetypes", "-j").stdout)["devicetypes"]
    with tempfile.TemporaryDirectory(prefix="IronAtlas-XCTest-") as build_dir:
        for kind in [opts.only] if opts.only else ["iphone", "ipad"]:
            receipt["devices"][kind] = run_device(kind, out / kind, app, runtimes, types, Path(build_dir))
            save(out / "receipt.json", receipt)
            print(f"{kind}: {receipt['devices'][kind]['status']}", flush=True)
    print(out / "receipt.json", flush=True)
    return 0 if all(d["status"] == "passed" for d in receipt["devices"].values()) else 1


if __name__ == "__main__":
    sys.exit(main())
