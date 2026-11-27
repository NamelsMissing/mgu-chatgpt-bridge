# Fahrzeugtelemetrie und Fahrtenbuch

Ab Vehicle Data 0.2.13, Companion Agent 0.2.14 und Pi 0.11.0 (Phase 1: Erfassung, Fahrterkennung, Puffer, Datenbank). Phase 2 mit Vehicle Data 0.2.14 und Pi 0.12.0 bringt die Statistikseite mit Diagrammen, Minutenaggregate und die Korrektur der Abdeckung im Stillstand. Erweiterte UDS-Werte und KI-Abfragen folgen.

```
SOME/IP-Notifier ─► Vehicle Data (MGU)                 ─► Companion Agent (MGU) ─► Pi
                    decode · aggregieren · Fahrt erkennen   GET /v1/telemetry          vehicle-telemetry.sqlite
                    data/telemetry/p-*.json (Puffer)        POST /v1/telemetry/ack     Fahrtzusammenfassung
                                                            POST /v1/telemetry/config  Reiter „Statistiken“
```

## Messwertekatalog

Eine Quelle: `apps/vehicle_data/telemetry_catalog.js`. Der Pi hat eine identische Kopie (`pi-source/telemetry-catalog.json`). `tests/telemetry-mgu.js` prüft, dass beide und das Manifest übereinstimmen. Pro Eintrag: ID, deutscher und englischer Name, Kategorie, Einheit, Interface, Feld, Member, Datentyp, Faktor und Offset, Ungültigkeitswerte, Gültigkeitsbereich, Intervall, Prüfstatus und Quelle.

Prüfstatus:

- `reference`: Skalierung im Repository belegt. Am G21 ist der Wert noch nicht bestätigt.
- `unverified`: Skalierung unbekannt. Der Wert wird als Rohwert (`unit: raw`) gespeichert und nie als physikalischer Wert angezeigt.
- `vehicle`: Am Fahrzeug bestätigt. Diesen Status hat noch kein Eintrag.

| ID | Interface.Feld → Member | Skalierung | Intervall | Status |
|---|---|---|---|---|
| speed | `Vehicle2.statusCarSpeed2` → `speedVehicleCentreOfGravity` | × 0,015625 km/h, 65535 ungültig | 2 s | reference |
| rpm | `CDS.statusEngineSpeed2` → `actualValueRPMEngineCrankshaft` | × 0,25 1/min | 2 s | reference |
| torque | `FES.statusActualValueTorque2` → `actualValueTorqueCrankshaft` | × 0,5 − 1023,5 Nm, ≥ 4095 ungültig | 2 s | reference |
| accelLong / accelLat | `CDS2.status…AccelerationMassCenter` | × 0,002 − 65 m/s² | 2 s | reference |
| coolant / oil | `CDS.statusEngineTemperature` → `temperatureEngineDrive` / `…OilDrive` | − 48 °C, 255 ungültig | 10 s | reference |
| exteriorRaw | `EnvironmentalInformation.ExteriorTemperature` | Rohwert | 60 s | unverified |
| fuelLevelRaw / rangeRaw | `KombiIF.statusRangeTankStatus` → `fluidLevelFuelTank` / `range` | Rohwert | 60 s | unverified |
| odometer | `KombiIF.statusRangeTankStatus` → `mileageKilometre` | km | 60 s | reference |
| gear / stage | `VehicleInformation.statusGearboxDrive` | Enum | bei Änderung | reference |
| condition | `VehicleCondition.VehicleCondition` → `statusConditionVehicle` (+ Qualifier) | Enum | bei Änderung | reference |
| sailing | `Efficiencytainment.statusPowerTrainSailing` | Enum | bei Änderung | reference |

Skalierungsquelle für Geschwindigkeit, Drehzahl, Drehmoment, Beschleunigung und Temperaturen: `kit/runtime/car.js` (BMW M Laptimer TypeConverters). Der Kombi-Kilometerstand dient nur der Plausibilisierung. Maßgeblich bleibt die bestehende Abfrage über KOMBI 0xD10D.

## Manifest und MGU Store

Alle Telemetriefelder stehen mit `s` im Manifest, also nur als Notifier-Abo. Neue Getter gibt es nicht. `tools/check_manifest_catalog.py` prüft jede Anforderung gegen den Katalog der Ziel-MGU: `r` braucht einen Getter, `s` einen Notifier, und Methoden, Broadcasts und Instanzen müssen vorhanden sein. Gegen den G21-Katalog meldet die Prüfung von allen Ergänzungen aus 0.2.2 genau `VehicleInformation.Range` als unzulässig. Das ist das Feld, an dem der Store 0.2.2 abgelehnt hat. Der Store-Build prüft das Pflichtmanifest gegen `tools/someip-catalog-excerpt.json` und gegen einen festen SHA-256 (`tools/build_store_app.py`). Lehnt der Store ein Paket trotzdem ab, bleibt die bisherige Version installiert.

```sh
python3 tools/check_manifest_catalog.py vehicle_data                                    # gegen den Auszug
python3 tools/check_manifest_catalog.py vehicle_data --catalog /privat/someip-interfaces.json --write-excerpt
```

## Aggregation auf der MGU

Felder kommen bei Änderung. Ein Wert gilt bis zur nächsten Meldung: während einer Fahrt oder bei Fahrbereitschaft bis zu 10 min bei schnellen Signalen (ein langer Ampelhalt ohne neue Meldung bleibt abgedeckt) und 15 bis 30 min bei Temperaturen, außerhalb einer Fahrt höchstens 30 s. Meldet ein Provider „nicht verfügbar“, endet der Wert sofort. Bis Vehicle Data 0.2.13 galt auch während der Fahrt nur 30 s; der Pi führt deshalb bei Geschwindigkeit, Drehzahl und den anderen schnellen Signalen Lücken bis 10 min innerhalb einer Fahrt mit dem letzten Wert fort und weist die fortgeführte Zeit aus (`filledMs`). Pro Signal und Intervall entsteht eine Zeile:

```
[signal, Bucket-Start ms UTC, abgedeckte ms, zeitgewichtetes Mittel, Min, Max, letzter Wert, Anzahl Meldungen]
```

Min und Max bleiben erhalten, deshalb geht eine Höchstgeschwindigkeit nicht durch Mittelung verloren. Enum-Änderungen sind Punktzeilen mit Dauer 0. Geschwindigkeitssprünge über 15 m/s² innerhalb von 5 s gelten als Messfehler und werden verworfen. Ungültige Werte (Ungültigkeitscode, außerhalb des Bereichs, falscher Typ) werden gezählt und nie gespeichert.

## Fahrterkennung

| Ereignis | Bedingung |
|---|---|
| Start | Geschwindigkeit > 3 km/h für mindestens 5 s oder Kilometerstand + 1 … 5 km. Der Start liegt beim Beginn der Fahrbereitschaft (`FAHRBEREITSCHAFT_HERSTELLEN`/`FAHREN`) oder des Motorlaufs, wenn dieser höchstens die Stillstandsgrenze davor lag. Der Warmlauf im Stand gehört damit zur Fahrt. |
| Fahrt hält | `FAHREN` gemeldet (auch Start-Stopp und Segeln), Motor läuft oder Bewegung |
| Ende „parked“ | Zustand `PARKEN_*`, `WOHNEN`, `STANDFUNKTIONEN…` oder `FAHRBEREITSCHAFT_BEENDEN` mit gültigem Qualifier, 30 s bestätigt und im Stand. Endzeit ist die letzte Aktivität. |
| Ende „idle_timeout“ | Keine Aktivität für die Stillstandsgrenze (Standard 10 min, einstellbar 2 bis 120) |
| MGU-Neustart | Zustand in `data/telemetry-state.json`. Ist die letzte Aktivität jünger als die Stillstandsgrenze, läuft die Fahrt weiter (`trip_resume`). Sonst wird sie mit `restart_timeout` zur letzten Aktivität beendet. |
| Kein Fahrtbeginn | Motor im Stand, Standheizung, kurze Geschwindigkeitsspitzen unter 5 s |

## Offline-Puffer

Pakete werden alle 30 s geschrieben, bei Fahrtereignissen und ab 1500 Zeilen sofort. Jedes Paket ist eine Datei `p-<ms>-<seq>-<bootId>.json`, atomar über eine Temp-Datei geschrieben. Die Paket-ID lautet `<bootId>-<seq>-<ms>`. Die Obergrenze ist standardmäßig 20 MB (einstellbar 2 bis 200) und 4000 Dateien. Bei Überlauf fallen zuerst die Messzeilen der ältesten Pakete weg. Fahrtereignisse bleiben als gekürztes Paket erhalten, erst danach werden auch diese gelöscht. Der Agent löscht ein Paket nur nach Bestätigung durch den Pi. Wird es erneut gesendet, erkennt der Pi es an der Paket-ID.

## Pi-Datenbank `vehicle-telemetry.sqlite`

Getrennt von `state.json`, der Fehlertext- und der Servicecode-Datenbank. Zugriff erfolgt über Pythons `sqlite3`, ohne npm-Abhängigkeit, mit einer Transaktion pro Aufruf, WAL und `auto_vacuum=INCREMENTAL`. Der Release-Workflow bündelt `telemetry.js` und den Katalog in `server.js`, weil der installierte Updater nur die Dateiliste von v0.8.0 annimmt.

| Tabelle | Inhalt |
|---|---|
| `meta` | Schemaversion (2). Eine Datenbank aus einer neueren Version wird nicht angefasst. Version 1 wird beim ersten Zugriff migriert. |
| `vehicles` | Fahrzeugschlüssel (Hash der MGU-Adresse, wie bei der Wartung) |
| `signals` | Katalog mit Prüfstatus |
| `packets` | Empfangene Paket-IDs zur Deduplizierung, mit verworfenen Zeilen und Uhr-Plausibilität |
| `samples` | Fahrzeug, Signal, ts (ms UTC, Messzeit), Dauer, Mittel, Min, Max, letzter Wert, Anzahl, Quelle, Paket. Indizes `(vehicle, signal, ts)` und `(vehicle, ts)` |
| `samples_minute` | Minutenwerte je Signal (abgedeckte ms, gewichtete Summe, Min, Max, Anzahl), beim Ingest fortgeschrieben, standardmäßig 24 Monate aufbewahrt. Diagramme älterer Fahrten nutzen sie, wenn die Rohdaten gelöscht sind. |
| `trips` | Start und Ende, km, Gründe, Status, Name, Kategorie, Zusammenfassung (JSON), `partial` bei rekonstruiertem Anfang |
| `events` | Fahrtereignisse je Paket |

Der Pi verwirft Zeilen mit unbekanntem Signal, nicht endlichen Zahlen, Min > Mittel, Mittel > Max, Werten außerhalb des Katalogbereichs, Zeitstempeln vor 2025 oder mehr als 10 min in der Zukunft, sowie Zeilen aus Paketen ohne plausible MGU-Uhr.

Die Aufbewahrung ist einstellbar: Rohdaten standardmäßig 30 Tage (7 bis 365). Das Speicherlimit liegt standardmäßig bei 500 MB. Ist es überschritten, werden die ältesten Messwerte in 10-%-Schritten gelöscht. Fahrten und ihre Zusammenfassungen bleiben erhalten. Die Wartung läuft einmal täglich. Tages-, Wochen- und Monatswerte der Statistikseite entstehen aus den Fahrtzusammenfassungen; gruppiert wird im Browser nach Ortszeit, damit Tagesgrenzen und Zeitumstellung stimmen.

## Fahrtzusammenfassung

- **Strecke:** Kilometerstand, wenn die Differenz mindestens 20 km beträgt. Sonst die integrierte Geschwindigkeit, wenn sie zu mindestens 80 % abgedeckt ist. Sonst der Kilometerstand. Die Quelle steht dabei.
- **Zeiten:** Bewegungszeit sind Buckets mit Max > 3 km/h. Motorlaufzeit sind Buckets mit Drehzahl-Mittel > 300 1/min. Leerlauf ist Motorlauf im Stand.
- **Geschwindigkeiten:** Ø in Bewegung ist die Strecke durch die Bewegungszeit, Ø gesamt die Strecke durch die Gesamtdauer. Die Höchstgeschwindigkeit ist das Max der bereits plausibilisierten Buckets.
- **Temperaturen:** „Start“ ist das zeitgewichtete Mittel des ersten 10-s-Buckets. Dazu kommen Min, Max und Mittel sowie Zeit und Strecke bis zur Schwelle (Öl und Kühlmittel je 80 °C, einstellbar).
- **Verbrauch:** Nicht verfügbar, solange der Tankfüllstand nicht in Litern bestätigt ist.
- **Geschwindigkeitsbereiche:** Bewegungszeit in 0–30, 30–60, 60–100, 100–130 und über 130 km/h (`speedBandsMs`).
- **Datenqualität:** Abdeckung je Signal. `good` heißt Geschwindigkeit ≥ 90 % und Drehzahl ≥ 80 %. `partial` heißt Geschwindigkeit ≥ 50 %. Alles darunter ist `poor`.

## API (Pi, angemeldet)

| Methode und Pfad | Zweck |
|---|---|
| `GET /api/v1/telemetry` | Einstellungen, Abrufstatus, MGU-Puffer, Datenbankgröße, Katalog |
| `POST /api/v1/telemetry/settings` | `enabled`, `idleEndMin`, `bufferMb`, `rawDays`, `limitMb`, `oilThresholdC`, `coolantThresholdC` |
| `POST /api/v1/telemetry/pull` | Sofort abfragen |
| `GET /api/v1/telemetry/trips?limit&before` | Fahrtenliste |
| `GET` / `POST` / `DELETE /api/v1/telemetry/trips/<id>` | Details, Name und Kategorie, Löschen nur mit `?confirm=1` |
| `GET /api/v1/telemetry/series?signals=a,b&from&to&max&fill` | Zeitreihen (bis 6 numerische Signale); Minutenwerte, wo keine Rohdaten mehr vorliegen; bei Ausdünnung bleiben Min und Max erhalten |
| `GET /api/v1/telemetry/trips/<id>/series?signals=coolant,oil` | Zeitreihen einer Fahrt |
| `GET /api/v1/telemetry/overview?from&to` | Fahrten eines Zeitraums mit Kennzahlen für die Statistikseite |
| `POST /api/v1/telemetry/reset` | Nur mit `{"confirm":"STATISTIK LÖSCHEN"}`. Wartung und Fehlerspeicher bleiben. |

## Datenschutz

Es gibt kein GPS. Die Messwerte bleiben auf dem Pi. In `state.json` stehen nur Einstellungen und Pufferstatus, keine Fahrtzeiten und keine Messwerte. Der GitHub-Diagnoseexport arbeitet mit einer festen Feldliste und enthält keine Telemetrie.

## Statistikseite (Pi 0.12.0)

Aufbau nach den Entwürfen des Eigentümers: Zeitfilter Heute, 7 Tage, 30 Tage, Gesamt; Kacheln Fahrstrecke, Ø Verbrauch, Fahrzeit, Höchstgeschwindigkeit; „Zurückgelegte Strecke“ als Balken (heute je Fahrt, 7 Tage je Tag, 30 Tage je Kalenderwoche, gesamt je Monat); „Kraftstoffverbrauch“ als Liniendiagramm; „Warmlaufverlauf“ der letzten Fahrt mit Kühlmittel, Motoröl und Getriebeöl und den Maximalwerten darunter; „Zeit nach Geschwindigkeit“. In den Fahrtdetails zusätzlich Warmlauf, Geschwindigkeit und Drehzahl, jeweils mit eigener Achse.

Die Diagramme sind eigenes SVG ohne externe Bibliothek: glatte, nicht überschwingende Kurven, gestrichelte Hilfslinien, Lücken bleiben Lücken, Finger oder Maus zeigen den Wert an jeder Stelle (Legende, Punkte, Zeitlabel oben). Verbrauch und Getriebeöl zeigen „–“, bis es echte Werte gibt: der Tankfüllstand ist noch nicht in Litern bestätigt, die Getriebeöltemperatur kommt per UDS in Phase 3.
