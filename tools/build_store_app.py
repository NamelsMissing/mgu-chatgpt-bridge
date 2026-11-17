#!/usr/bin/env python3
"""MGU Store build entry point for the apps in this repository.

The store runs `python3 tools/build_store_app.py <app-id>`. Every app is built with
kit/tools/build.py. That builder does not copy `mguAppStartType` from app.json into
package.json, so apps listed in AUTOSTART_APPS get it added to both archives
(.tgz for the store, .mgu for mgu-deploy) afterwards, and the result is verified.
Ported from NamelsMissing/mgu-apps (tools/build_wheelheat_autostart.py).
"""

import json
import os
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

AUTOSTART_APPS = ("vehicle_data",)
START_TYPES = ("autostart", "manually")
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


def patch_start_type(root, app_id, start_type):
    if app_id not in AUTOSTART_APPS or start_type not in START_TYPES:
        raise BuildError("Unsupported start type for " + app_id + ": " + str(start_type))
    version = read_json(root / "apps" / app_id / "app.json")["version"]
    dist, stage = root / "dist", root / "dist" / app_id
    package_path = stage / "source" / "package.json"
    package = read_json(package_path)
    if package.get("name") != app_id or package.get("version") != version:
        raise BuildError("Staged app/version mismatch; rebuild with your SDK")
    npm, mgu = dist / (app_id + "@" + version + ".tgz"), dist / (app_id + "@" + version + ".mgu")
    if not npm.is_file() or not mgu.is_file() or not (stage / "meta.json").is_file():
        raise BuildError("Expected SDK .tgz, .mgu and meta.json are missing")
    package["mguAppStartType"] = start_type
    package_path.write_text(json.dumps(package, indent=2) + "\n", encoding="utf-8")
    pending = []
    try:
        pending.append((_archive(stage, npm, (("source", "package"),)), npm, "package/package.json"))
        pending.append((_archive(stage, mgu, ((n, n) for n in MGU_MEMBERS)), mgu, "source/package.json"))
        for temporary, _out, member in pending:
            _verify(temporary, member, app_id, start_type)
        for temporary, out, _member in pending:
            os.replace(temporary, out)
    finally:
        for temporary, _out, _member in pending:
            temporary.unlink(missing_ok=True)
    return npm, mgu


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1 or not args[0] or args[0].startswith("-"):
        print("Usage: python3 tools/build_store_app.py <app-id>", file=sys.stderr)
        return 2
    app_id, root = args[0], Path(__file__).resolve().parents[1]
    if not (root / "apps" / app_id / "app.json").is_file():
        print("Unknown app: " + app_id, file=sys.stderr)
        return 2
    try:
        subprocess.run([sys.executable, str(root / "kit" / "tools" / "build.py"), app_id], cwd=root, check=True)
        if app_id in AUTOSTART_APPS:
            start_type = read_json(root / "apps" / app_id / "app.json").get("mguAppStartType")
            npm, mgu = patch_start_type(root, app_id, start_type)
            print("Verified " + app_id + " " + start_type + " in " + str(npm) + " and " + str(mgu))
    except (BuildError, OSError, subprocess.CalledProcessError, ValueError, KeyError) as exc:
        print("MGU Store build failed: " + str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
