# Vehicle Data

Liest Kilometerstand, Servicebedarf (CBS) und die im Fahrzeug gespeicherte Servicehistorie über SOME/IP und schreibt sie nach `bmw-vehicle-data.json` im Datenordner der App (`/var/opt/public/oap/oap_<uid>/data/`). Der **BMW AI Companion Agent** aus diesem Repository (`native/mgu-ai-agent`, ab 0.2.4) liest die Datei und gibt die Werte an den Raspberry Pi weiter (Website, Reiter „Fahrzeug“). Die App startet mit dem Auto (`mguAppStartType: autostart`) und zeigt dieselben Werte auf zwei Seiten im iDrive an.

Nur lesend: keine Setter, kein Zurücksetzen des Service, keine Diagnosebefehle an Steuergeräte.

| Wert | Interface / Feld (Master-Katalog) | Gelesen als | Aktualisierung |
|---|---|---|---|
| Kilometerstand | `de.bmw.infrastructure.SecureMileage` `mileage.currentMileage` (UInt32), Ersatz `de.bmw.infrastructure.MileageSupreme` `mileageSupreme` | km | bei jeder Meldung, zusätzlich alle 5 Minuten abgefragt |
| Servicebedarf | `de.bmw.infotainment.ConditionBasedServicesLegacy` `cBSMessageEngineOil`, `…BrakeFront`, `…BrakeRear`, `…GearOil`, `…ParticleFilter`, `…SparkPlug` | Restkilometer (UInt16) in km, Fälligkeit mit Jahr = 2000 + UInt8 | nur wenn das Fahrzeug eine Meldung schickt |
| Servicehistorie | `com.harman.infotainment.systemfunctions.servicehistory.ServiceHistory`, Methode `readServiceHistory` (Instanz `SystemFunctionsServiceHistoryInst1`), Event `serviceHistoryUpdated` | Datum, km, Händlernummer, Arbeiten | 8 s nach dem Start, alle 6 Stunden, bei „geändert“ und per Taste |

Die Datei wird bei jeder Änderung geschrieben, höchstens einmal pro Sekunde, atomar über eine Zwischendatei.

**Noch am Auto zu prüfen:** Der Katalog nennt keine Einheiten. Die Annahmen oben sind im Dateiinhalt als `unverified` markiert, bis Kilometerstand und Servicebedarf einmal mit Kombi und iDrive („Fahrzeugstatus“ → „Servicebedarf“) verglichen wurden. Den ersten Rohwert jedes Signals schreibt die App ins Log (`vehicle raw …`).

## Bauen und testen

```sh
python3 tools/build_store_app.py vehicle_data   # setzt zusätzlich den Autostart im Paket
node tests/vehicle-data-app.js
```

Bis 17.11.2026 lag die App in [NamelsMissing/mgu-apps](https://github.com/NamelsMissing/mgu-apps); sie gehört fachlich zu BMW AI und wird nur noch hier gepflegt.
