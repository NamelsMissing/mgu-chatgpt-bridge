#!/usr/bin/env python3
"""MGU Store build entry point for the apps in this repository.

The store runs `python3 tools/build_store_app.py <app-id>`. Every app is built with
kit/tools/build.py. That builder does not copy `mguAppStartType` from app.json into
package.json, so apps listed in AUTOSTART_APPS get it added to both archives
(.tgz for the store, .mgu for mgu-deploy) afterwards, and the result is verified.
Ported from NamelsMissing/mgu-apps (tools/build_wheelheat_autostart.py).
"""

import argparse
import copy
import hashlib
import json
import os
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

from validate_someip_manifest import (
    Incompatible, Unverified, VEHICLE_GETTERS, read_manifest, validate,
)

AUTOSTART_APPS = ("vehicle_data",)
START_TYPES = ("autostart", "manually")
# Canonical JSON SHA-256 of the packaged manifest from the installed v0.2.1.
VEHICLE_BASE_MANIFEST_SHA256 = "fef209704187d45e15c09ad4171be402948ed44670e3e515fd16803c72ab01b9"
MGU_MEMBERS = ("meta.json", "source", "rhmiData", "rhmiDataStartWidget", "oapgen")


class BuildError(RuntimeError):
    pass


def read_json(path):
    if not path.is_file():
        raise BuildError("Missing file: " + str(path))
    return json.loads(path.read_text(encoding="utf-8"))


def _archive(directory, output, roots):
    with tempfile.NamedTemporaryFile(dir=output.parent, prefix=output.name + ".", suffix=".tmp", delete=False) as f:
        temporary = Path(f.name)
    try:
        with tarfile.open(temporary, "w:gz") as tar:
            for local, name in roots:
                if (directory / local).exists():
                    tar.add(directory / local, arcname=name)
        return temporary
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _verify(archive, member, app_id, start_type):
    with tarfile.open(archive, "r:gz") as tar:
        f = tar.extractfile(member)
        package = json.load(f) if f else {}
    if package.get("name") != app_id or package.get("mguAppStartType") != start_type:
        raise BuildError(str(archive) + " lacks the requested start type")


def patch_start_type(root, app_id, start_type, manifest=None):
    if app_id not in AUTOSTART_APPS or start_type not in START_TYPES:
        raise BuildError("Unsupported start type for " + app_id + ": " + str(start_type))
    version = read_json(root / "apps" / app_id / "app.json")["version"]
    dist, stage = root / "dist", root / "dist" / app_id
    package_path = stage / "source" / "package.json"
    package = read_json(package_path)
    if package.get("name") != app_id or package.get("version") != version:
        raise BuildError("Staged app/version mismatch; rebuild with your SDK")
    npm, mgu = dist / (app_id + "@" + version + ".tgz"), dist / (app_id + "@" + version + ".mgu")
    if not (stage / "meta.json").is_file():
        raise BuildError("Expected staged meta.json is missing")
    package["mguAppStartType"] = start_type
    package_path.write_text(json.dumps(package, indent=2) + "\n", encoding="utf-8")
    pending = []
    try:
        pending.append((_archive(stage, npm, (("source", "package"),)), npm, "package/package.json"))
        pending.append((_archive(stage, mgu, ((n, n) for n in MGU_MEMBERS)), mgu, "source/package.json"))
        for temporary, _out, member in pending:
            _verify(temporary, member, app_id, start_type)
            if manifest is not None:
                archive_member = member.replace("package.json", "manifest.json")
                with tarfile.open(temporary, "r:gz") as archive:
                    if json.load(archive.extractfile(archive_member)) != manifest:
                        raise BuildError("Pakete enthalten unterschiedliche SOME/IP-Manifeste")
        for temporary, out, _member in pending:
            os.replace(temporary, out)
    finally:
        for temporary, _out, _member in pending:
            temporary.unlink(missing_ok=True)
    return npm, mgu


def vehicle_manifest(root, args):
    file = root / "dist" / "vehicle_data" / "source" / "manifest.json"
    base = read_manifest(file)
    canonical = json.dumps(base, sort_keys=True, separators=(",", ":")).encode()
    if hashlib.sha256(canonical).hexdigest() != VEHICLE_BASE_MANIFEST_SHA256:
        raise BuildError("Das Pflichtmanifest weicht vom Installationsstand 0.2.1 ab")
    if args.catalog is None:
        print("SOME/IP: Pflichtmanifest identisch zu 0.2.1; Zielkatalog nicht geprüft.")
        return base
    validate(base, args.catalog, args.app_management, args.uid)
    if not args.with_supported_getters:
        print("SOME/IP: Pflichtmanifest gegen den angegebenen Zielkatalog geprüft.")
        return base
    current = base
    for interface, fields in VEHICLE_GETTERS.items():
        for field in fields:
            candidate = copy.deepcopy(current)
            entry = candidate["proxies"].setdefault(interface, {"instances": "1"})
            entry.setdefault("attributes", {})[field] = "r"
            try:
                validate(candidate, args.catalog, args.app_management, args.uid)
            except Incompatible:
                print("SOME/IP: optionaler Getter nicht freigegeben: " + interface + "." + field)
                continue
            current = candidate
            print("SOME/IP: optionaler Getter freigegeben: " + interface + "." + field)
    validate(current, args.catalog, args.app_management, args.uid)
    file.write_text(json.dumps(current, indent=2) + "\n", encoding="utf-8")
    return current


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app_id")
    parser.add_argument("--catalog", type=Path)
    parser.add_argument("--app-management", type=Path)
    parser.add_argument("--uid", type=int)
    parser.add_argument("--with-supported-getters", action="store_true",
                        help="Zusatz-Getter in ein lokales, kataloggebundenes Vehicle-Data-Paket aufnehmen")
    args = parser.parse_args(argv)
    if args.catalog or args.app_management or args.uid is not None or args.with_supported_getters:
        if args.app_id != "vehicle_data" or not all((args.catalog, args.app_management, args.uid)):
            parser.error("Zielkatalog-Prüfung benötigt vehicle_data, --catalog, --app-management und --uid")
    app_id, root = args.app_id, Path(__file__).resolve().parents[1]
    if not (root / "apps" / app_id / "app.json").is_file():
        print("Unknown app: " + app_id, file=sys.stderr)
        return 2
    try:
        builder = [sys.executable, str(root / "kit" / "tools" / "build.py")]
        if app_id in AUTOSTART_APPS:
            builder.append("--stage-only")
        subprocess.run(builder + [app_id], cwd=root, check=True)
        manifest = vehicle_manifest(root, args) if app_id == "vehicle_data" else None
        if app_id in AUTOSTART_APPS:
            start_type = read_json(root / "apps" / app_id / "app.json").get("mguAppStartType")
            npm, mgu = patch_start_type(root, app_id, start_type, manifest)
            print("Verified " + app_id + " " + start_type + " in " + str(npm) + " and " + str(mgu))
    except Unverified as exc:
        print("NICHT VERIFIZIERT: " + str(exc), file=sys.stderr)
        return 2
    except (BuildError, Incompatible, OSError, subprocess.CalledProcessError, ValueError, KeyError) as exc:
        print("MGU Store build failed: " + str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
