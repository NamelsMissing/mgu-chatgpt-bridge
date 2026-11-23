# Vehicle Data

Liest Kilometerstand, Servicebedarf (CBS) und die im Fahrzeug gespeicherte Servicehistorie über SOME/IP und schreibt sie nach `bmw-vehicle-data.json` im Datenordner der App (`/var/opt/public/oap/oap_<uid>/data/`). Der **BMW AI Companion Agent** aus diesem Repository (`native/mgu-ai-agent`, ab 0.2.4, für Fehlerspeicher auf Anfrage ab 0.2.5) liest die Datei und gibt die Werte an den Raspberry Pi weiter (Website, Reiter „Fahrzeug“). Die App startet mit dem Auto (`mguAppStartType: autostart`) und zeigt dieselben Werte auf vier Seiten im iDrive an.

Nur lesend: keine Setter, kein Zurücksetzen des Service. An Steuergeräte gehen nur die Lesedienste UDS `0x19 02` und `0x22`; die Klasse `ReadOnlyDiag` in `main.js` lehnt jeden anderen Dienst ab (auch `0x14` Fehlerspeicher löschen, `0x2E`, `0x31`, `0x10`), siehe `tests/vehicle-data-app.js`.

| Wert | Interface / Feld (Master-Katalog) | Gelesen als | Aktualisierung |
|---|---|---|---|
| Kilometerstand | `de.bmw.infrastructure.SecureMileage` `mileage.currentMileage` (UInt32), Ersatz `de.bmw.infrastructure.MileageSupreme` `mileageSupreme` | km | bei jeder Meldung, zusätzlich alle 5 Minuten abgefragt |
| Servicebedarf | `de.bmw.infotainment.ConditionBasedServicesLegacy` `cBSMessageEngineOil`, `…BrakeFront`, `…BrakeRear`, `…GearOil`, `…ParticleFilter`, `…SparkPlug` | Restkilometer (UInt16) in km, Fälligkeit mit Jahr = 2000 + UInt8 | nur wenn das Fahrzeug eine Meldung schickt |
| Servicehistorie | `com.harman.infotainment.systemfunctions.servicehistory.ServiceHistory`, Methode `readServiceHistory` (Instanz `SystemFunctionsServiceHistoryInst1`), Event `serviceHistoryUpdated` | Datum, km, Händlernummer, Arbeiten | 8 s nach dem Start, alle 6 Stunden, bei „geändert“ und per Taste |

Ab 0.2.0 zusätzlich:

| Wert | Quelle | Aktualisierung |
|---|---|---|
| Check-Control-Meldungen | `CheckControlMaster` `basicList` (ID, Steuergerät, aktiv/inaktiv), Text über `KombiInterface_2` `newCCMessage` bzw. `requestCCMessage(id)` | bei jeder Meldung, zusätzlich jede Minute |
| Reifendruck | `TPMSInternalData` `tpmsInternalLastValues` (Druck und Solldruck in mbar, Temperatur in °C, Batteriestatus) | jede Minute |
| Fehlerspeicher | UDS `0x19 02` mit Statusmaske `0x0C` funktional an alle Steuergeräte (über `InternalTasu`), Codes mit Status | 90 s nach dem Start und auf Anfrage vom Pi |
| Dieselpartikelfilter | UDS `0x22` an die DDE (0x12), Kennungen wie DPF Monitor (`dpf_dids.js`) | alle 5 Minuten, Nebenwerte alle 30 Minuten |

Anfragen vom Pi (Fehlerspeicher jetzt auslesen) kommen über den Agenten als `bmw-vehicle-request.json` im Datenordner; die App prüft die Datei alle 3 Sekunden. Fehlercodes erscheinen ohne Klartext, weil die Steuergeräte-Beschreibungen (PRG) nicht vorliegen.

Die App schreibt atomar über eine Zwischendatei. Ab 0.2.1 aktualisiert sie alle 20 Sekunden den Heartbeat. Änderungen an Fahrzeugwerten und ihre Messzeiten bleiben davon getrennt. Der Companion Agent 0.2.6 meldet den Heartbeat und den Zustand der lokalen Übergabe.

**Noch am Auto zu prüfen:** Der Katalog nennt keine Einheiten. Die Annahmen oben sind im Dateiinhalt als `unverified` markiert, bis Kilometerstand und Servicebedarf einmal mit Kombi und iDrive („Fahrzeugstatus“ → „Servicebedarf“) verglichen wurden. Den ersten Rohwert jedes Signals schreibt die App ins Log (`vehicle raw …`).

## Bauen und testen

```sh
python3 tools/build_store_app.py vehicle_data   # setzt zusätzlich den Autostart im Paket
node tests/vehicle-data-app.js
```

Bis 17.11.2026 lag die App in [NamelsMissing/mgu-apps](https://github.com/NamelsMissing/mgu-apps); sie gehört fachlich zu BMW AI und wird nur noch hier gepflegt.

Ab 0.2.2 liest Vehicle Data zusätzlich die in BMW `x_call` belegten Getter
`VehicleInformation.Range`, `KombiInterface_2.ccList` und
`KombiInterface_2.cbsDataServiceList`. Herkunft, Grenzen und Schritte zur
Fahrzeugprüfung stehen im [Prüfbericht](../../docs/PRUEFBERICHT-FAHRZEUGDATEN-0.10.0.md).
