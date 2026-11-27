#!/usr/bin/env python3
"""Check an app's SOME/IP requests against the head unit's catalog, without BMW's generator.

The MGU Store refuses an app whose manifest asks for something the unit's catalog does not
offer. Vehicle Data 0.2.2 was refused for exactly that: "r" on VehicleInformation.Range, a
field that the G21 catalog lists without a getter. This check reproduces that rule:

    r -> the field has a getter      s -> the field has a notifier
    w -> refused (Vehicle Data only reads)
    methods / broadcasts -> present in the interface
    instances -> a named instance must exist ("*" and ${userId} are left to the generator)

Usage:
    check_manifest_catalog.py <app-id> --catalog someip-interfaces.json   # full unit catalog
    check_manifest_catalog.py <app-id>                                    # committed excerpt
    check_manifest_catalog.py <app-id> --catalog FULL --write-excerpt     # refresh the excerpt

The excerpt keeps only what this check needs for the requested interfaces: field names with
their getter/notifier flags, method and event names, and instance names. The full catalog
stays private.
"""

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
EXCERPT = ROOT / "tools" / "someip-catalog-excerpt.json"
sys.path.insert(0, str(ROOT / "kit" / "tools"))


def manifest(app_id):
    from build import manifest_for
    spec = json.loads((ROOT / "apps" / app_id / "app.json").read_text(encoding="utf-8"))
    return manifest_for(spec)


def normalise(catalog):
    """Full catalog (interfaces/instanceIDs) or excerpt -> {iface: {fields, methods, events, instances}}."""
    if "interfaces" not in catalog:
        return catalog["interfaces_excerpt"]
    result, ids = {}, catalog.get("instanceIDs", {})
    for name, entry in catalog["interfaces"].items():
        result[name] = {
            "fields": {field: {"getter": "getter" in value, "notifier": "notifier" in value}
                       for field, value in entry.get("fields", {}).items()},
            "methods": sorted(entry.get("methods", {})),
            "events": sorted(entry.get("events", {})),
            "instances": sorted(ids.get(name, {})),
        }
    return result


def check(requested, catalog):
    failures = []
    for interface, request in requested["proxies"].items():
        if not isinstance(request, dict):
            continue
        actual = catalog.get(interface)
        if actual is None:
            failures.append(interface + ": Schnittstelle fehlt im Katalog")
            continue
        instances = request.get("instances")
        for instance in instances if isinstance(instances, list) else [instances]:
            if isinstance(instance, str) and instance not in ("*",) and "${" not in instance and instance not in actual["instances"]:
                failures.append(interface + ": Instanz " + instance + " fehlt")
        for field, flags in request.get("attributes", {}).items():
            descriptor = actual["fields"].get(field)
            if descriptor is None:
                failures.append(interface + "." + field + ": Feld fehlt")
                continue
            if "r" in flags and not descriptor["getter"]:
                failures.append(interface + "." + field + ": kein Getter im Katalog")
            if "s" in flags and not descriptor["notifier"]:
                failures.append(interface + "." + field + ": kein Notifier im Katalog")
            if "w" in flags:
                failures.append(interface + "." + field + ": Schreibzugriff angefordert")
        for name in request.get("methods", []):
            if name not in actual["methods"]:
                failures.append(interface + "." + name + ": Methode fehlt")
        for name in request.get("broadcasts", []):
            if name not in actual["events"]:
                failures.append(interface + "." + name + ": Broadcast fehlt")
    return failures


def excerpt(requested, catalog):
    out = {}
    for interface, request in requested["proxies"].items():
        if not isinstance(request, dict) or interface not in catalog:
            continue
        actual = catalog[interface]
        fields = request.get("attributes", {})
        out[interface] = {
            "fields": {field: actual["fields"][field] for field in sorted(fields) if field in actual["fields"]},
            "methods": sorted(set(request.get("methods", [])) & set(actual["methods"])),
            "events": sorted(set(request.get("broadcasts", [])) & set(actual["events"])),
            "instances": actual["instances"],
        }
    return {"schema": 1, "note": "Auszug aus someip-interfaces.json der Ziel-MGU (G21) fuer die angeforderten Felder; erzeugt mit tools/check_manifest_catalog.py --write-excerpt",
            "interfaces_excerpt": dict(sorted(out.items()))}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("app_id")
    parser.add_argument("--catalog", type=Path)
    parser.add_argument("--write-excerpt", action="store_true")
    args = parser.parse_args(argv)
    source = args.catalog or EXCERPT
    catalog = normalise(json.loads(source.read_text(encoding="utf-8")))
    requested = manifest(args.app_id)
    failures = check(requested, catalog)
    if failures:
        print("INKOMPATIBEL mit " + source.name + ":\n  " + "\n  ".join(failures), file=sys.stderr)
        return 1
    if args.write_excerpt:
        if not args.catalog:
            parser.error("--write-excerpt braucht --catalog mit dem vollstaendigen Katalog")
        EXCERPT.write_text(json.dumps(excerpt(requested, catalog), indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    count = sum(len(r.get("attributes", {})) for r in requested["proxies"].values() if isinstance(r, dict))
    print("Katalogpruefung bestanden: " + str(count) + " Felder gegen " + source.name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
