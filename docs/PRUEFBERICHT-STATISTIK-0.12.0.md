# Prüfbericht Fahrzeugstatistik Phase 2 · Pi 0.12.0, Vehicle Data 0.2.14

Ausgangsstand `611f667` (Pi 0.11.0, Vehicle Data 0.2.13, Agent 0.2.14). Erste Fahrt am Fahrzeug am 27.11.2026: Der MGU Store hat Vehicle Data 0.2.13 mit den neuen Notifier-Abos angenommen, die Fahrt wurde erkannt und auf dem Pi gespeichert (Start 98.640 km). Damit sind Installation, Abos und Übertragung am Fahrzeug bestätigt; die Skalierungen einzelner Werte noch nicht.

## Befund aus der ersten Fahrt

Datenqualität „lückenhaft“, Geschwindigkeit nur zu 37 % abgedeckt, Ø gesamt 1 km/h. Ursache: Die MGU meldet ein Feld nur bei Änderung. Im Stand kommt nach 0 km/h nichts mehr, Vehicle Data 0.2.13 ließ den letzten Wert aber nur 30 s gelten. Korrektur:

- **Vehicle Data 0.2.14:** Während einer Fahrt und bei Fahrbereitschaft gilt der letzte Wert schneller Signale bis zu 10 min, solange der Provider verfügbar ist; außerhalb einer Fahrt weiter 30 s. Manifest unverändert (gleicher Hash), kein neues Store-Risiko.
- **Pi 0.12.0:** Führt bei bereits gespeicherten Fahrten Lücken bis 10 min innerhalb der Fahrt mit dem letzten Wert fort, weist die fortgeführte Zeit aus und rechnet Zusammenfassungen der Version 1 automatisch neu. Lücken über 10 min bleiben Lücken.

## Neu

- Statistikseite nach den Entwürfen: Zeitfilter, vier Kennzahlkacheln, Strecke als Balken, Verbrauchsdiagramm, Warmlaufverlauf mit Maximalwerten, Zeit nach Geschwindigkeit; in den Fahrtdetails Warmlauf, Geschwindigkeit und Drehzahl. Eigene SVG-Diagramme mit Finger- und Mausbedienung, getrennten Achsen je Einheit und echten Lücken.
- Datenbank-Schema 2: Minutenwerte (`samples_minute`, standardmäßig 24 Monate), Migration aus Schema 1, Zeitreihen greifen auf Minutenwerte zurück, wenn Rohdaten gelöscht sind.
- API: `overview`, mehrere Signale je Zeitreihe, Zeitreihen je Fahrt.
- Einstellungen: Fahrzeugname für die Überschrift, Aufbewahrung der Minutenwerte.

## Bewusst noch leer

- **Verbrauch:** Kachel und Diagramm zeigen „–“ und einen Hinweis. Freigabe, sobald die Einheit des Tankfüllstands bestätigt ist.
- **Getriebeöl:** Legende und Maximalwert zeigen „–“ bis Phase 3 (UDS, Getriebesteuergerät).
- Zoom und frei zusammenstellbare Dashboards sind noch nicht enthalten.

## Tests

Alle Läufe grün: `npm test`, `npm run test:pi`, `python3 tests/test-someip-manifest.py`, `node tests/motorscope-import.mjs`, `python3 tests/dtc-reference-test.py`, `python3 tools/check_manifest_catalog.py vehicle_data`. Neu oder erweitert:

- `tests/telemetry-mgu.js`: ein 4-minütiger Halt ohne neue Meldung bleibt während der Fahrt abgedeckt; außerhalb einer Fahrt endet ein Wert nach 30 s.
- `pi-source/tests/test-telemetry-db.js`: Fortführung bis 10 min, Loch über 10 min bleibt, Geschwindigkeitsbereiche, Übersicht, mehrere Zeitreihen, Minutenwerte nach Löschen der Rohdaten mit erhaltenem Maximum und zeitgewichtetem Mittel, Migration von Schema 1.
- `tests/telemetry-pipeline.js`: Übersicht und Fahrt-Zeitreihen über echten Agenten und Pi, Enums werden nicht als Kurve ausgeliefert.
- Darstellung mit einer Woche synthetischer Fahrten in Chrome bei 390 × 844 px geprüft (alle Zeitfilter, Fingerbedienung, Fahrtdetails), ohne Skriptfehler.

## Nächste Prüfung am Fahrzeug

1. Vehicle Data 0.2.14 im MGU Store installieren, Pi auf 0.12.0 aktualisieren.
2. Eine Fahrt mit Ampelhalt: Datenqualität sollte „vollständig“ sein, Stillstand und Ø gesamt plausibel.
3. Warmlaufverlauf mit der Temperaturanzeige vergleichen, falls verfügbar.
4. Für den Verbrauch: Rohwert „Tankfüllstand“ unter Einstellungen → Messwerte und die Tankanzeige im Kombi notieren.

Die Commit-ID dieses Prüfstands ist über `git log -1 --format=%H -- docs/PRUEFBERICHT-STATISTIK-0.12.0.md` abrufbar.
