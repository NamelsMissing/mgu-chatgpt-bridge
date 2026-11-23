#!/usr/bin/env python3
"""Test the validator with a generator fixture; no BMW firmware is included."""

import json
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from validate_someip_manifest import Incompatible, Unverified, validate
from build_store_app import vehicle_manifest

sys.path.insert(0, str(ROOT / "kit" / "tools"))
from build import manifest_for

FIRMWARE = r'''
(function(modules) {return function (id) {return modules[id]();};})({
    1:function () {/* "someip-interfaces-generator/IFConfigGenerator":1 */
      return {generate:function (catalog, manifest) {
        const result = {};
        for (const name of Object.keys(manifest.proxies)) {
          const actual = catalog[name];
          if (!actual) continue;
          if (JSON.stringify(manifest.proxies[name].instances) !== JSON.stringify(actual.instance))
            throw Error('instance unavailable: '+manifest.proxies[name].instances);
          result[name]=actual;
        }
        return result;
      }};
    },
    2:function () {/* "someip-interfaces-generator/AclGenerator":2 */
      return {generate:function () {return {offers:[],requests:[]};}};
    }
},{},[3]);
'''


class ManifestTest(unittest.TestCase):
    def test_capabilities_and_missing_inputs(self):
        interface = "sample.telemetry"
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            catalog, firmware = folder / "catalog.json", folder / "AppManagement.js"
            manifest = {"proxies": {interface: {"instances": "1", "attributes": {"Reading": "rs"},
                                                "methods": ["Read"], "broadcasts": ["Updated"]}}}
            with self.assertRaises(Unverified):
                validate(manifest, catalog, firmware, 123)
            catalog.write_text(json.dumps({interface: {
                "instance": "1", "fields": {"Reading": {"event": {"id": 1}, "getter": {"id": 2}}},
                "methods": {"Read": {"id": 3}}, "events": {"Updated": {"id": 4}},
            }}))
            with self.assertRaises(Unverified):
                validate(manifest, catalog, firmware, 123)
            firmware.write_text(FIRMWARE.strip())
            self.assertIn(interface, validate(manifest, catalog, firmware, 123))
            for change, expected in (
                ({"instances": "2"}, "instance unavailable"),
                ({"attributes": {"Wrong": "r"}}, "Feld fehlt"),
                ({"attributes": {"Reading": "w"}}, "setter fehlt"),
                ({"methods": ["Wrong"]}, "methods fehlt"),
                ({"broadcasts": ["Wrong"]}, "broadcasts fehlt"),
            ):
                with self.assertRaisesRegex(Incompatible, expected):
                    validate({"proxies": {interface: {**manifest["proxies"][interface], **change}}},
                             catalog, firmware, 123)
            data = json.loads(catalog.read_text())
            for capability in ("getter", "event"):
                copy = json.loads(json.dumps(data))
                del copy[interface]["fields"]["Reading"][capability]
                catalog.write_text(json.dumps(copy))
                with self.assertRaisesRegex(Incompatible, capability + " fehlt"):
                    validate(manifest, catalog, firmware, 123)
            with self.assertRaisesRegex(Incompatible, "Schnittstelle fehlt"):
                validate({"proxies": {"missing": {}}}, catalog, firmware, 123)

    def test_only_supported_extra_getters_are_packaged(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            stage = folder / "dist" / "vehicle_data" / "source"
            stage.mkdir(parents=True)
            spec = json.loads((ROOT / "apps" / "vehicle_data" / "app.json").read_text())
            base = manifest_for(spec)
            target = stage / "manifest.json"
            target.write_text(json.dumps(base))
            data = {}
            for interface, request in base["proxies"].items():
                request = request if isinstance(request, dict) else {}
                data[interface] = {
                    "instance": request.get("instances"),
                    "fields": {field: {kind: {"id": 1} for flag, kind in (("r","getter"),("s","event"),("w","setter"))
                                       if flag in flags}
                               for field, flags in request.get("attributes", {}).items()},
                    "methods": {name: {} for name in request.get("methods", [])},
                    "events": {name: {} for name in request.get("broadcasts", [])},
                }
            kombi = "de.bmw.infotainment.KombiInterface_2"
            data[kombi]["fields"]["ccList"] = {"getter": {"id": 2}}
            catalog, firmware = folder / "catalog.json", folder / "AppManagement.js"
            firmware.write_text(FIRMWARE.strip())
            for value in data.values():
                if value["instance"] is None:
                    del value["instance"]
            catalog.write_text(json.dumps(data).replace("${userId}", "123"))
            actual = vehicle_manifest(folder, SimpleNamespace(catalog=catalog,app_management=firmware,
                                                               uid=123,with_supported_getters=True))
            self.assertEqual(actual["proxies"][kombi]["attributes"],
                             {**base["proxies"][kombi]["attributes"], "ccList": "r"})
            self.assertNotIn("de.bmw.infrastructure.VehicleInformation", actual["proxies"])
            self.assertEqual(json.loads(target.read_text()), actual)


if __name__ == "__main__":
    unittest.main()
