# Prüfbericht Fahrzeugstatistik Phase 1 · Pi 0.11.0, Vehicle Data 0.2.13, Companion Agent 0.2.14

Ausgangsstand ist `b92b389` (Pi 0.10.15, Vehicle Data 0.2.12, Agent 0.2.13). Phase 1 umfasst Messwertekatalog, Fahrzeugzustandserkennung, notifier-basierte SOME/IP-Telemetrie, automatische Fahrtenaufzeichnung, Offline-Puffer, Pi-Datenbank, eine Fahrtenliste im neuen Reiter „Statistiken“ und Einstellungen. Technische Beschreibung: [telemetry.md](telemetry.md).

## Versionen

| Komponente | Vorher | Jetzt | Grund |
|---|---|---|---|
| Vehicle Data | 0.2.12 | **0.2.13** | Telemetrie, neue Notifier-Abos im Manifest |
| Companion Agent | 0.2.13 | **0.2.14** | `GET /v1/telemetry`, `POST /v1/telemetry/ack`, `POST /v1/telemetry/config` |
| Pi-Server | 0.10.15 | **0.11.0** | Telemetrie-Datenbank, API, Reiter „Statistiken“ |
| BMW AI Bridge | 0.2.2 | 0.2.2 | unverändert |

Das signierte Pi-Update erzeugt der Workflow „Publish signed BMW AI Pi update“ nach dem Push. Er bündelt `telemetry.js` und den Katalog in `server.js`. Das gebündelte Paket wurde lokal mit derselben Bündelung gestartet und hat `/api/v1/telemetry` mit 15 Messwerten beantwortet.

## Manifest und Store-Risiko

Neu im Pflichtmanifest sind ausschließlich Notifier-Abos (`s`), keine Getter und keine Methoden:

`Vehicle2.statusCarSpeed2`, `CDS.statusEngineSpeed2`, `CDS.statusEngineTemperature`, `CDS2.statusLongitudinalAccelerationMassCenter`, `CDS2.statusLateralAccelerationMassCenter`, `FES.statusActualValueTorque2`, `KombiIF.statusRangeTankStatus`, `EnvironmentalInformation.ExteriorTemperature` (der Plattformeintrag `UnitBN2020: rs` bleibt unverändert), `VehicleInformation.statusGearboxDrive`, `VehicleCondition.VehicleCondition`, `Efficiencytainment.statusPowerTrainSailing`.

Nachweise:

- `tools/check_manifest_catalog.py` gegen die vom Eigentümer bereitgestellte `someip-interfaces.json` des G21: Alle 32 angeforderten Felder sind zulässig.
- Gleiche Prüfung für das installierte Manifest 0.2.1: zulässig.
- Gleiche Prüfung für die Getter-Ergänzungen aus 0.2.2: Gemeldet wird nur `VehicleInformation.Range` („kein Getter im Katalog“). Das deckt sich mit der Store-Ablehnung von 0.2.2.
- Der Store-Build prüft das Pflichtmanifest gegen den Katalogauszug und den festen Hash `af9d7824…`.

Eine Prüfung mit BMWs Generator (`AppManagement.js`) lag nicht vor. Das verbleibende Risiko ist eine Ablehnung aus einem Grund, den der Katalog nicht abbildet, etwa eine ACL. In dem Fall bleibt Vehicle Data 0.2.12 installiert, wie bei 0.2.2. Eine Fehlinstallation ist ausgeschlossen.

## Signale und Prüfstatus

| Status | Signale |
|---|---|
| **Referenzbelegt** (Skalierung aus `kit/runtime/car.js`, Enums aus dem Katalog) | speed, rpm, torque, accelLong, accelLat, coolant, oil, odometer, gear, stage, condition, sailing |
| **Nur Rohwert** (Skalierung unbekannt) | exteriorRaw, fuelLevelRaw, rangeRaw |
| **Synthetisch getestet** | alle 15 über die Testfahrt `tests/fixtures/synthetic-drive.js` |
| **Am Fahrzeug bestätigt** | keines |

Verifizierte UDS-DIDs: In Phase 1 sind keine neuen UDS-Abfragen hinzugekommen. Fehlerspeicher, Kilometerstand (KOMBI 0xD10D), RDC und DPF laufen unverändert über die gemeinsame Diagnose-Warteschlange.

## Ressourcen (synthetische Fahrt, gemessen auf x86 mit Node 22)

| Größe | Wert |
|---|---|
| Notifier-Last im Test | ca. 100 Meldungen/s (20 Hz je schnellem Signal) |
| CPU der Aggregation | ca. 0,46 s pro Fahrstunde (0,013 %). Auf der MGU mit ARM und Node 8 ist mit dem 10- bis 20-Fachen zu rechnen, also unter 0,3 %. Das ist noch zu messen. |
| Arbeitsspeicher | Puffer höchstens 30 s Zeilen (< 2000) plus Zustand je Signal. Im Host-Test nicht getrennt messbar. |
| Paketvolumen MGU → Pi | ca. 515 KiB pro Fahrstunde (≈ 10 000 Zeilen) |
| MGU-Puffer | höchstens 20 MB, also etwa 40 Fahrstunden ohne Pi-Verbindung |
| Pi-Datenbank | ca. 1,4 MB pro Fahrstunde inklusive Indizes. Bei 30 Tagen Rohdaten und 1 h Fahrt täglich ca. 42 MB. |
| Ingest auf dem Pi | ca. 0,1 s pro Fahrstunde |
| Zusätzliche Diagnoseabfragen | keine |

## Tests

Alle Testläufe sind grün: `npm test`, `npm run test:pi`, `python3 tests/test-someip-manifest.py`, `node tests/motorscope-import.mjs`, `python3 tests/dtc-reference-test.py`, `python3 tools/check_manifest_catalog.py vehicle_data`.

Neu:

| Test | Inhalt |
|---|---|
| `tests/telemetry-mgu.js` | Katalog vollständig und identisch auf Pi und Manifest; Dekodierung inklusive Ungültigkeitswerten, Bereich, Typfehlern, Enums als Name und Zahl, Qualifier; zeitgewichtetes Mittel, erhaltene Spitzen, Halten und Lücken; Testfahrt mit Kaltstart, 6 Start-Stopp-Halten, Segeln, Landstraße, Autobahn und Parken als genau eine Fahrt; Strecke ±1 %, Höchstgeschwindigkeit exakt; Stillstandsgrenze ohne Zustandssignal; Motor im Stand ist keine Fahrt; Start per Kilometerstand; Geschwindigkeitsspitzen; MGU-Neustart mit Fortsetzung und mit Abschluss; atomarer Puffer, Limit, Fahrtereignisse bleiben; Aufzeichnung per Pi abschaltbar, Grenzen der Einstellungen; Providerverlust |
| `tests/vehicle-data-telemetry-wiring.js` | Echte `main.js` im Paketlayout: 9 Interfaces nur als Notifier, kein Getter, kein Polling, `Range` nicht angefragt; Werte, Verfügbarkeit und Status bis in den Snapshot |
| `tests/node87-syntax.js` | Neue MGU-Dateien und Agent frei von Syntax und APIs nach Node 8.7 |
| `pi-source/tests/test-telemetry-db.js` | Deduplizierung; Verwerfen von 7 Arten ungültiger Zeilen und von Paketen mit unplausibler Uhr; handgerechnete Zusammenfassung über die Zeitumstellung am 25.10.2026; Fahrten getrennt nach Fahrzeug; rekonstruierter Fahrtanfang; Zeitreihe mit erhaltenen Extremwerten; Aufbewahrung nach Alter (Fahrten bleiben); Speicherlimit mit Schrumpfen der Datei; Löschen, Zurücksetzen, Schutz vor neuerem Schema; Einstellungsgrenzen |
| `tests/telemetry-pipeline.js` | Echter Agent und echter Pi-Prozess: 40+ offline gepufferte Pakete, Agent-Liste und Bestätigung (unautorisiert 401, Pfad-Manipulation wirkungslos), Speicherung mit Messzeit, Pakete danach auf der MGU gelöscht, Fahrtzusammenfassung, Duplikat nach verlorener Bestätigung, Name und Kategorie, Zeitreihe, Einstellungen landen über den Agenten bei Vehicle Data, `state.json` ohne Messwerte und Fahrtzeiten, Pi-Neustart, Löschbestätigung, Zurücksetzen lässt die Wartung unberührt |
| `tests/test-someip-manifest.py` | zusätzlich: Manifest gegen Katalogauszug, 0.2.2-Ablehnung reproduziert, Telemetrie nur `s`, fehlender Notifier wird erkannt |

Der Reiter „Statistiken“ wurde mit den Testdaten in Chrome bei 390 × 844 px (iPhone) geöffnet: Liste, Fahrtdetails und Einstellungen, ohne Skriptfehler.

## Bewusst nicht enthalten

- Verbrauch: kommt erst, wenn die Einheit des Tankfüllstands bestätigt ist.
- Diagramme, Zeitfilter und Aggregate: Phase 2.
- UDS-Werte (DDE, Getriebe, 48 V): Phase 3.
- KI-Abfragen: Phase 4.
- Die vollständige aktive Check-Control-Liste bleibt offen wie in 0.10.15.

## Checkliste für den ersten Fahrtest

1. Im MGU Store **Vehicle Data 0.2.13** und **Companion Agent 0.2.14** installieren, den Pi auf **0.11.0** aktualisieren. Lehnt der Store Vehicle Data ab, die Meldung notieren; 0.2.12 bleibt dann aktiv.
2. Auf der Website **Fahrzeug → Fahrzeugdaten-Diagnose** öffnen. In der Gruppe „Fahrtenbuch (Notifier-Abos)“ sollte bei eingeschalteter Zündung für jedes Feld „Manifest Lesen nein / Abo ja · Provider ja · Abo erfolgreich“ stehen. Fehlt ein Feld oder steht dort „Abo fehlgeschlagen“, den Diagnoseexport sichern.
3. Kurz fahren (10 bis 15 min, mit Ampelhalt), danach abstellen und abschließen. Nach etwa 1 min **Statistiken → Aktualisieren**.
4. Vergleichen:
   - **Strecke** mit dem Tageskilometerzähler.
   - **Höchstgeschwindigkeit** grob mit dem Tacho. Der Tacho zeigt etwas mehr an, der Wert hier ist die Schwerpunktgeschwindigkeit.
   - **Öl- und Kühlmitteltemperatur max.** mit der M-/Sport-Anzeige oder dem Diagnosewert, falls verfügbar.
   - **Start- und Endzeit**: Die Fahrt sollte mit dem Losfahren beziehungsweise dem Zündung-Ein beginnen und beim Abstellen enden, nicht an der Ampel.
5. Unter **Einstellungen und Speicher → Messwerte und Prüfstatus** stehen die Rohwerte. Für Außentemperatur, Tankfüllstand und Reichweite bitte die Anzeige im Kombi notieren. Damit lassen sich die Skalierungen bestätigen und der Verbrauch freischalten.
6. Ergebnisse zurückmelden. Bestätigte Signale bekommen dann im Katalog den Status `vehicle`.

Die Commit-ID dieses Prüfstands ist über `git log -1 --format=%H -- docs/PRUEFBERICHT-STATISTIK-0.11.0.md` abrufbar.
