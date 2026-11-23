# BMW AI 0.10.1 · Fahrzeugquellen und MotorScope-Fehlertexte

Ausgangspunkt war `c43f2d1` auf `main`. Der veröffentlichte Stand war Vehicle Data 0.2.3, Companion Agent 0.2.7 und Pi 0.10.0. Die vom Nutzer beschriebene Bildschirmaufnahme zeigt die Pi-0.10.0-Funktionen. Die auf der MGU installierten Buildstände waren für diese Prüfung nicht direkt abrufbar. Neu sind Vehicle Data **0.2.4**, Companion Agent **0.2.8** und Pi **0.10.1**.

## Befunde zur Bildschirmaufnahme

| Beobachtung | Belegt und umgesetzt | Offen am G21 |
| --- | --- | --- |
| Fehlercodes ohne Beschreibung | Die Pi-App hatte ein lokales JSON-Schema, aber keinen Importpfad für die MotorScope-Exporte. Der neue Import verwendet MotorScopes bestehendes PRG-Exportformat und bewahrt die BMW-Titel aus `faultTexts`. Das Pi-Backend lädt die Datei beim Start und bei Änderung. Es zeigt Anzahl der Texte und ECU-Zuordnungen an und protokolliert fehlende oder mehrdeutige Zuordnungen zusammengefasst. | Kein privater Referenzexport mit nachgewiesener ECU-/SGBD-Zuordnung lag vor. MotorScopes private G21-Liste bezeichnet ihre PRG-Kandidaten ausdrücklich als ungeprüft. Es wurden daher keine Fahrzeugcodes mit diesen Kandidaten vorbelegt. |
| Kilometerstand leer | SecureMileage und MileageSupreme bleiben im Manifest. Manifest-Leserecht, generierter Getter, Proxy, Provider, erster und letzter Abruf, Antwort und Decoder werden separat erfasst. Der Kilometerstand wird weiterhin nur aus dekodierten Fahrzeugantworten übernommen. | Ursache auf der konkreten MGU und weitere belegte Quellen. `VehicleInformation.Range` war laut Store auf dieser Headunit nicht lesbar. |
| Check-Control unvollständig | Der Pi weist den Zustand als unvollständig aus, solange keine vollständige Liste übernommen wurde. Die bestehende Decoder- und Textverarbeitung bleibt erhalten. | `ccList` wurde im BMW-Spenderpaket beschrieben. Seine Unterstützung im G21-Katalog und eine echte Antwort bleiben offen. |
| CBS fehlt, Historie erscheint | Die vorhandene Historienabfrage bleibt erhalten. Der Export trennt Legacy-CBS-Abos und den optionalen Getter von der Servicehistorie. | Für vollständige CBS-Werte fehlt ein Beleg für `cbsDataServiceList` oder eine alternative Quelle im G21-Katalog. |
| Reifen leer | Der Diagnoseexport unterscheidet Provider, Getter und erhaltene Rohform für TPMSInternalData. Die geprüfte mbar-/°C-Dekodierung bleibt bestehen. | Ob das Auto verwertbare direkte RDC-Daten liefert und welche Gültigkeitskennungen vorkommen. Kein Reifendruck wird abgeleitet oder simuliert. |

## Fehlertexte aus MotorScope übernehmen

MotorScope hat einen PRG-Importer und kann bereits einzelne SGBD-Kataloge oder ein `motorscope-catalog-bundle` exportieren. BMW AI verwendet diesen Export als Datenquelle und übernimmt weder die privaten PRG-Dateien noch den privaten Parser. Deutsche Texte bleiben unverändert deutsch, wenn sie im ausgewählten Referenzexport deutsch sind. Eine separat verifizierte technische Beschreibung kann in der bestehenden Pi-Datei ergänzt werden. Existiert nur ein Titel, bleibt das Beschreibungsfeld leer.

Die Eingabedatei für ECU-Identitäten hat `schema: 1` und ein Objekt `ecu`. Der Schlüssel ist die **dezimale** ECU-Adresse. Eine Zeile benötigt `family`, `sgbd`, optional `variant` und `verified: true`. Die Werte müssen aus nachgewiesener Steuergeräteidentifikation stammen. Ein ausschließlich aus dem Modellnamen abgeleiteter SGBD-Kandidat reicht dafür nicht. Die Kombination aus Adresse, Familie, SGBD, Variante und sechsstelliger DTC wird exakt aufgelöst. Mehrdeutige Kataloge sowie Demo-Kataloge werden abgewiesen.

```sh
node pi-tools/import-motorscope-dtc.mjs MOTOR_SCOPE_EXPORT.json ECU_IDENTITIES.json /pfad/zum/DATA_DIR/dtc-texts.json
```

Der Import schreibt mit privatem Dateimodus und verweigert das Überschreiben bestehender Dateien. Eine aktualisierte Sammlung zunächst in eine neue lokale Datei exportieren und prüfen. Danach kann sie am Pi-Standort `DATA_DIR/dtc-texts.json` verwendet werden. Die Website übernimmt eine Änderung beim nächsten Aufruf der Fehleransicht. Gründe für unbekannte Einträge sind fehlende oder defekte Datenbank, fehlende ECU-Identität, mehrdeutiger Eintrag und unbekannter Code für diese ECU. Im öffentlichen Repository befinden sich nur Programmcode und fiktive Testdaten.

## Diagnose und Fahrzeugprüfung

1. Vehicle Data 0.2.4 und Companion Agent 0.2.8 im Store aktualisieren sowie Pi 0.10.1 installieren. In **Fahrzeug → Technische Fahrzeugdaten-Diagnose** den bereinigten Export erstellen. Er enthält die Stufen pro Quelle und getrennte Zeitpunkte für den geschriebenen Snapshot, die Weitergabe durch den Agenten, den Empfang und die Speicherung der Diagnose auf dem Pi.
2. Im Export für Kilometerstand und Reifen zuerst Manifestrecht und installierten Getter prüfen. Drei aufeinanderfolgende Getter-Fehler pausieren nur diesen Getter. Eine neue gemeldete Provider-Verbindung gibt ihn wieder frei. Ein Getter ohne generierte Berechtigung wird übersprungen. Ein eigener Ablauf überwacht hängenbleibende Getter-Antworten.
3. Für eine vollständige Check-Control- und CBS-Liste den G21-Katalog und passenden BMW-Generator privat bereitstellen. `tools/validate_someip_manifest.py` prüft das tatsächlich gebaute Paket. Der vorhandene lokale Build mit `--with-supported-getters` kann bestätigte Zusatzfelder aufnehmen. Standardpakete behalten das Pflichtmanifest von 0.2.1. Es wurde in 0.2.4 kein optionaler Getter als Pflichtanforderung hinzugefügt.
4. Einen MotorScope-Export und bestätigte Identitäten für die betroffenen ECUs bereitstellen. Nach dem Import Titel und Textquellen mit MotorScope vergleichen. Der nächste Fehlerspeicherscan bleibt lesend.

## Prüfungen und Dateien

Geändert wurden `apps/vehicle_data/`, `kit/runtime/signals.js`, `native/mgu-ai-agent/`, `pi-source/` und `mgu-repo.json`. Der private Konverter liegt in `pi-tools/import-motorscope-dtc.mjs`. Die Update-Pipeline behält das zugelassene Pi-ZIP-Dateilayout. DPF-Abfragen, Servicehistorie, UDS-Statusauswertung und Freigaben wurden nicht neu implementiert.

Automatisierte Prüfungen umfassen `npm test`, `npm run test:pi`, `python3 tests/test-someip-manifest.py`, `node tests/motorscope-import.mjs`, Node-8.7-Syntax und den MGU-Paketbau samt Pflichtmanifest. Die Tests verwenden Testreferenzen und echte lokale Agent-/Pi-Prozesse. Ein neuer G21-Diagnoseexport, der Zielkatalog und die privaten MotorScope-Texte lagen nicht vor. Installation, Fahrzeugantworten und die Zuordnung der 32 gemeldeten Fehlercodes bleiben am Zielsystem zu prüfen.

Die Commit-ID ist über `git log -1 --format=%H -- docs/PRUEFBERICHT-FAHRZEUGDIAGNOSE-0.10.1.md` abrufbar.
