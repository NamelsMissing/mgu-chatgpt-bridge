# Vehicle Data 0.2.3 · Installationskompatibilität

Ausgangsstand `2efcdc9`. Das Fahrzeug behielt Vehicle Data 0.2.1 und lehnte 0.2.2 vor der Installation ab. Der Store meldete, dass `de.bmw.infrastructure.VehicleInformation.Range` auf dieser Headunit nicht gelesen werden kann. Die Leseanforderung war aus einer anderen BMW-Firmware in das Pflichtmanifest übernommen worden. Dass `x_call` den Getter auf einem Spendergerät benutzt, belegt keine Freigabe auf dem G21.

## Manifest und Laufzeit

0.2.2 hat gegenüber 0.2.1 folgende fünf Getter mit Zugriff `r` und Instanz `1` ergänzt. Dabei kamen keine neuen Methoden, Ereignisabonnements oder Schreibfreigaben hinzu.

| Neu in 0.2.2 | Befund für den G21 | Store-Paket 0.2.3 |
| --- | --- | --- |
| `VehicleInformation.Range` | Vom MGU Store als nicht lesbar abgewiesen | Entfällt aus dem Pflichtmanifest |
| `KombiInterface_2.ccList` | Ohne Zielkatalog ungeprüft | Entfällt aus dem Pflichtmanifest |
| `KombiInterface_2.cbsDataServiceList` | Ohne Zielkatalog ungeprüft | Entfällt aus dem Pflichtmanifest |
| `TPMS.statusTyrePressure` | Ohne Zielkatalog ungeprüft | Entfällt aus dem Pflichtmanifest |
| `TPMS.statusTargetTyrePressure` | Ohne Zielkatalog ungeprüft | Entfällt aus dem Pflichtmanifest |

Das Standardpaket deklariert exakt die Anforderungen des auf dem Fahrzeug installierten 0.2.1. Dazu gehören `SecureMileage`, `MileageSupreme`, die sechs Legacy-CBS-Felder, die Check-Control-Ereignisse und der vorhandene Textabruf sowie `TPMSInternalData`, ServiceHistory und TASU. Das Paket behält Initialabfragen, Wiederholungen, Decoder, bereinigten Diagnoseexport und Autostart aus 0.2.2. Die Zusatz-Getter werden erst genutzt, wenn sie im installierten Manifest stehen und die generierte Proxy-Konfiguration einen Getter enthält. Ohne `ccList` meldet die Website einen unvollständigen Check-Control-Stand. Ohne BMW-CBS-Liste bleiben die empfangenen Legacy-Werte die Grundlage für die nächste Wartung. Eine weitere bestätigte Kilometerstandsquelle für den G21 lag nicht vor.

## Versionen und Datenformat

- **Vehicle Data 0.2.1 → 0.2.2 → 0.2.3.** 0.2.3 korrigiert die Installationsanforderungen. Snapshot-Schema 1 und die in 0.2.2 hinzugekommenen Diagnose- und Quellenfelder bleiben erhalten.
- **Companion Agent 0.2.6 → 0.2.7.** 0.2.7 reicht die optionalen Diagnose-, Check-Control- und CBS-Felder an den Pi weiter. Die Protokoll- und Schema-Versionen wurden nicht erhöht. An Agent 0.2.7 ist für diesen Fix keine Änderung erforderlich.
- **Pi 0.9.1 → 0.10.0.** 0.10.0 verarbeitet vorhandene Basisdaten und die neuen optionalen Felder. Es zeigt bestätigte Teilergebnisse und ergänzte Fehlertexte weiterhin an. Ein neues Pi-ZIP ist für die 0.2.3-Installation nicht erforderlich.

## Prüfung des Zielkatalogs

Der Validator prüft das **tatsächlich gepackte** Manifest. Er verwendet die BMW-Interface- und ACL-Generatoren aus `AppManagement.js` der Ziel-Firmware. Die Auswertung der generierten Proxydateien prüft zusätzlich auf Schnittstellen, Felder, Getter, Subscriptions, Methoden und Broadcasts. Instanzvorgaben werden an den BMW-Generator übergeben. Exit-Code 1 bedeutet inkompatibel. Exit-Code 2 bedeutet nicht verifiziert, etwa wenn Katalog oder Generator fehlen.

```sh
python3 tools/validate_someip_manifest.py dist/vehicle_data@0.2.3.tgz \
  --catalog /privat/someip-interfaces.json \
  --app-management /privat/AppManagement.js --uid OAP_ID
```

`OAP_ID` durch die numerische Installations-ID ohne `oap_` ersetzen. Auf der MGU kann der Validator auch die installierten Standardpfade verwenden. Ein lokales, nur für den jeweiligen Zielkatalog vorgesehenes Paket lässt sich mit denselben Optionen und zusätzlich `--with-supported-getters` bauen. Dabei ergänzt der Builder nur vom Generator einzeln akzeptierte Getter und prüft die kombinierte Anforderung erneut. Der Standard-Store-Aufruf `python3 tools/build_store_app.py vehicle_data` bleibt bei den Pflichtanforderungen von 0.2.1. Katalog, Firmware-Auszug, SDK und lokal gebaute Pakete bleiben privat.

## Ergebnisse und Endabnahme

- Die erzeugten `.tgz`- und `.mgu`-Manifeste wurden aus den Archiven gelesen und als JSON mit dem gebauten Paket 0.2.1 verglichen. Alle Pflichtanforderungen sind identisch. Beide Archive enthalten den Autostart-Eintrag. Der Standard-Build prüft diesen Vergleich bei jedem Lauf.
- `npm test`, `npm run test:pi`, `node tests/vehicle-data-app.js`, `node tests/vehicle-pipeline.js` und `python3 tests/test-someip-manifest.py` prüfen unter anderem die Basisfunktion, die Getter-Sperre, die Archiv- und Prozessübergabe sowie Fehlerklassifikation mit einem Testgenerator.
- Der Katalog und der passende BMW-Generator des G21 lagen für diese Änderung nicht vor. Der Validator meldete dafür **NICHT VERIFIZIERT**. Die Store-Meldung für `Range` ist die vorliegende Fahrzeugbeobachtung. Installation, Autostart und Übertragung von 0.2.3 wurden am Fahrzeug noch nicht geprüft.
- Am Fahrzeug 0.2.3 als Update über 0.2.1 installieren und die Store-Meldung prüfen. Danach Fahrzeug und Fehler in der Weboberfläche öffnen und bei fehlenden Werten den bereinigten Diagnoseexport prüfen. Das bisherige 0.2.1-Paket bleibt als Rückfallstand im Workspace; der zugehörige Quellstand bleibt unter [73c7fb0](https://github.com/NamelsMissing/mgu-chatgpt-bridge/tree/73c7fb0ae4509cc01e7498bf9d7d1380fc12bc1c) abrufbar.

Die Commit-ID des Prüfstands ist über `git log -1 --format=%H -- docs/PRUEFBERICHT-VEHICLE-DATA-0.2.3.md` abrufbar.
