#!/usr/bin/env python3
"""Validate an installed archive's actual manifest using the target BMW OAP generator."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
GENERATOR = ROOT / "kit" / "tools" / "oapgen" / "gen.js"
ON_UNIT_CATALOG = Path("/etc/oap/someip/someip-interfaces.json")
ON_UNIT_APP_MANAGEMENT = Path("/usr/lib/oap-mainapp/src/AppManagement/AppManagement.js")
LOCAL_CATALOG = ROOT / "reference" / "someip-interfaces.json"

VEHICLE_GETTERS = {
    "de.bmw.infrastructure.VehicleInformation": ["Range"],
    "de.bmw.infotainment.KombiInterface_2": ["ccList", "ccListRiskClass", "cbsDataServiceList"],
    "de.bmw.infotainment.vehicle.TPMS": ["statusTyrePressure", "statusTargetTyrePressure"],
}


class Unverified(RuntimeError):
    """The target's catalog or generator was unavailable."""


class Incompatible(RuntimeError):
    """The supplied generator rejected the manifest."""


def read_manifest(file):
    if file.suffix == ".json":
        return json.loads(file.read_text(encoding="utf-8"))
    member = "source/manifest.json" if file.suffix == ".mgu" else "package/manifest.json"
    with tarfile.open(file, "r:gz") as archive:
        return json.load(archive.extractfile(member))


def validate(manifest, catalog, firmware, uid):
    if not catalog.is_file():
        raise Unverified("Zielkatalog fehlt: " + str(catalog))
    if not firmware.is_file():
        raise Unverified("AppManagement.js der Zielfirmware fehlt: " + str(firmware))
    # Treat unreadable or corrupt input as missing verification evidence.
    try:
        json.loads(catalog.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise Unverified("Zielkatalog kann nicht gelesen werden") from exc
    with tempfile.TemporaryDirectory(prefix="vehicle-someip-") as tmp:
        directory = Path(tmp)
        candidate = directory / "manifest.json"
        candidate.write_text(json.dumps(manifest), encoding="utf-8")
        output = directory / "generated"
        try:
            result = subprocess.run(
                ["node", str(GENERATOR), str(catalog.resolve()), str(candidate), str(uid), str(output)],
                capture_output=True, text=True, timeout=30,
                env={**os.environ, "OAP_APPMGMT": str(firmware.resolve())},
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise Unverified("BMW OAP-Generator konnte nicht ausgeführt werden") from exc
        if result.returncode:
            detail = (result.stderr.strip() or result.stdout.strip())[:2400]
            if "not found in " in detail or "unexpected AppManagement bundle format" in detail or "Cannot find module" in detail:
                raise Unverified("BMW OAP-Generator konnte nicht geladen werden: " + detail)
            raise Incompatible(detail or "BMW OAP-Generator hat das Manifest zurückgewiesen")
        if not (output / "acl.json").is_file():
            raise Unverified("BMW OAP-Generator hat keine ACL erzeugt")
        generated = {
            interface: json.loads(config.read_text(encoding="utf-8"))
            for interface in manifest.get("proxies", {})
            for config in [output / (interface.replace(".", "_") + ".json")]
            if config.is_file()
        }
        # The generated shape is used by the SDK's someipBuilders: fields
        # have getter/setter/event descriptors; methods and broadcasts have
        # their own maps. Catch omissions even if the generator exits cleanly.
        failures = []
        for interface, request in manifest.get("proxies", {}).items():
            if interface not in generated:
                failures.append(interface + ": Schnittstelle fehlt")
                continue
            if not isinstance(request, dict):
                continue
            config = generated[interface]
            for field, flags in request.get("attributes", {}).items():
                descriptor = config.get("fields", {}).get(field)
                if not isinstance(descriptor, dict):
                    failures.append(interface + "." + field + ": Feld fehlt")
                    continue
                for flag, kind in (("r", "getter"), ("s", "event"), ("w", "setter")):
                    if flag in flags and not descriptor.get(kind):
                        failures.append(interface + "." + field + ": " + kind + " fehlt")
            for category, generated_key in (("methods", "methods"), ("broadcasts", "events")):
                for name in request.get(category, []):
                    if name not in config.get(generated_key, {}):
                        failures.append(interface + "." + name + ": " + category + " fehlt")
        if failures:
            raise Incompatible("\n".join(failures))
        return generated


def default_catalog():
    return ON_UNIT_CATALOG if ON_UNIT_CATALOG.is_file() else LOCAL_CATALOG


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path, help="manifest.json, .tgz oder .mgu")
    parser.add_argument("--catalog", type=Path, default=default_catalog())
    parser.add_argument("--app-management", type=Path, default=ON_UNIT_APP_MANAGEMENT)
    parser.add_argument("--uid", type=int, required=True, help="OAP-Installations-ID der App, ohne oap_")
    args = parser.parse_args()
    try:
        validate(read_manifest(args.manifest), args.catalog, args.app_management, args.uid)
    except Incompatible as exc:
        print("INKOMPATIBEL: " + str(exc), file=sys.stderr)
        return 1
    except (Unverified, OSError, ValueError, tarfile.TarError, KeyError) as exc:
        print("NICHT VERIFIZIERT: " + str(exc), file=sys.stderr)
        return 2
    print("Katalogprüfung bestanden: BMW OAP-Generator hat das Paketmanifest verarbeitet.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
