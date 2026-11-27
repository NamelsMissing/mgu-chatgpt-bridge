# Check-Control · Prüfbericht

| Komponente | Ausgangsstand | Neuer Stand |
| --- | --- | --- |
| Vehicle Data | 0.2.9 | 0.2.10 |
| BMW AI Companion Agent | 0.2.12 | 0.2.13 |
| Raspberry Pi | 0.10.13 | 0.10.14 |

Ausgangsbasis ist `a03cb92` auf `main`. Die Wartungsberechnung, Service- und DTC-Referenzdatenbanken, Kilometerstands-, RDC- und DPF-Abfragen waren außerhalb des Änderungsumfangs.

## Ursachen und Korrekturen

- Vehicle Data behandelte `basicList` als einzelnen Struct. Dadurch lieferte die katalogkonforme Array-Antwort keine Meldungen. Die App liest jetzt alle gültigen Zeilen, einschließlich expliziter Deaktivierungen. Nur ein erfolgreicher, vollständig dekodierter Array-Getter ersetzt die aktive Menge. Ereignisse und unvollständige Antworten ergänzen den letzten Stand um die einzeln verwertbaren Einträge.
- Bei `ccList` ging bisher alles außer der ID verloren. Die App übernimmt jetzt den Originalkurztext, Farbe, Symbol, Einrückung und Ressourcen-ID. `ccListRiskClass` liefert zusätzlich die originale Risikoklasse. Die Methode `requestCCMessage` ergänzt nach Abgleich mit der angefragten ID die Beschreibung. `newCCMessage` liefert Texte zeitnah. Ob diese Meldung aktiv ist, ergibt sich aus einer Liste oder einem expliziten Statusereignis.
- Der Companion Agent übernimmt den Zeitpunkt und die Quelle der letzten vollständigen Liste sowie die Empfangsdiagnose. Der Pi speichert Ereignisse und die empfangenen Originaltexte getrennt von UDS und Servicecodes im lokalen Monitorzustand der aktuellen Fahrzeugkopplung. Sprache und Softwarekontext lassen sich aus dem Nachrichtentyp allein nicht bestimmen. Für fehlende Titel bleibt die ID sichtbar.
- Die Website zeigt die BMW-Farbe und ein passendes Warn- oder Informationssymbol. Originale Symbol-IDs, Risikoklassen und Meldungstypen sind in den technischen Details sichtbar. Die Katalog-Enums belegen ihre Werte, jedoch keine allgemeine Übersetzung von `RK…` oder `TYP_…` in eine Dringlichkeit. Push-Priorität folgt daher der Farbe: Rot 5, Gelb/Orange 3, sonst 2. Der Pi speichert den Versand pro Auftreten.
- Der private Diagnoseexport enthält getrennte Getter-/Event-Empfangsbelege mit Datentyp, Anzahl, Ablehnungsgründen, Validität, Zeit und jeweils empfangenen IDs, Farben und Texten. Die Ausgabe ist begrenzt. FIN- und Zugangsdatenmuster werden in den Texten maskiert.

## Statisch anhand des Zielkatalogs geprüft

Alle folgenden Einträge beschreiben Instanz 1. Die Katalogdefinition und die OAP-Berechtigung sind getrennte Prüfschritte.

| Quelle | Definition | Standardpaket |
| --- | --- | --- |
| `CheckControlMaster.basicList` | `BasicCCMInfo[0..45]`, Getter 1, Notifier 32769, Eventgruppe 1. `AKTIV=0`, `INAKTIV=1`. | Getter und Subscription bereits deklariert |
| `KombiInterface_2.ccList` | `CCListElementUnion[0..42]`, Getter 7, Notifier 32770, Eventgruppe 1. ID-Feld `cCIdentifer`. Lokaler BMW-App-Code aus `x_call` bestätigt die Union und die Schreibweise. | Optionaler Getter über bestehenden validierten Paketbau |
| `KombiInterface_2.ccListRiskClass` | `CCListRiskClassElementUnion[0..42]`, Getter 16, Notifier 32773, Eventgruppe 1. Die Liste enthält `cCRiskClass` mit Werten wie `RK10`, `RK800` und `UNKNOWN`. | Optionaler Getter über denselben Paketbau |
| `KombiInterface_2.requestCCMessage` | Methode 1, `id: UInt16`, Antwort `requestedCCMessage: CCMessageUnion`. | Lesende Methode bereits deklariert |
| `KombiInterface_2.newCCMessage` | `CCMessageUnion`, Getter 6, Notifier 32769, Eventgruppe 1. | Subscription bereits deklariert |

`CCMessageUnion` enthält `cCMessageStruct` und `cCMessageWithSymbol.cCMessage`. Der Katalog beschreibt die Texte als UTF-16-BE. Der App-Decoder verarbeitet JavaScript-Strings aus dem Proxy einschließlich deutscher Sonderzeichen. Das tatsächliche Laufzeitformat der Ziel-MGU muss ein Mitschnitt bestätigen.

Das erzeugte Manifest besitzt dasselbe SOME/IP-Pflichtprofil wie Vehicle Data 0.2.1. Die lokale Validierung des fertigen Pakets mit dem Zielkatalog meldete `NICHT VERIFIZIERT`, weil `/usr/lib/oap-mainapp/src/AppManagement/AppManagement.js` der Zielfirmware fehlte. Daher bleiben die zusätzlichen Getter außerhalb des Standardpakets. Der private Diagnoseexport mit Companion Agent 0.2.13 prüft sie lesend mit dem Generator auf der MGU, wenn dieser unter dem erwarteten Pfad zugänglich ist.

In den lokal vorliegenden KOMBI-PRGs (`KOMBSP18.prg`, `KOMBSP21.prg`, `KOMB_G11.prg`) ließ sich bei der gezielten Textsuche keine verifizierbare Zuordnung von CC-ID zu Meldungstext belegen. Ein späterer Abgleich kann die passenden Original-HMI-Ressourcen verwenden. Für deren private Lokalisierung auf der MGU eignet sich dieser lesende Suchbefehl:

```sh
find /usr/lib/oap-mainapp /var/opt/public/oap -type f \( -iname '*checkcontrol*' -o -iname '*ccmessage*' -o -iname '*ricresource*' \) -print 2>/dev/null
```

## Automatisiert geprüft

- `npm test`, `npm run test:pi`, `python3 tests/test-someip-manifest.py`, `node tests/motorscope-import.mjs`, `python3 tests/dtc-reference-test.py`.
- Synthetische SOME/IP-Formen mit mehreren IDs, einzelnen Events, leeren Gettern und Events, widersprüchlichen IDs, unbekanntem Status, beiden Kombi-Listen, beiden Text-Unionen und falsch zugeordneter Methoden-Antwort.
- Lokale Agent-Pi-HTTP-Integration, persistierter Pi-Zustand, Wiederanlauf mit einem partiellen MGU-Snapshot, Offline-/Veraltet-Status, zeitlich überholte Events, Push-Prioritäten und Wiederholungsschutz.
- JavaScript-Syntax unter Node 8.7 für die geänderten MGU-Komponenten. Store-Bau für `.tgz` und `.mgu` einschließlich Autostart und Vergleich des generierten Pflichtmanifests.

## Installation und Fahrzeugabnahme

Pi 0.10.14 über Stable aktualisieren und im MGU Store Vehicle Data 0.2.10 und Companion Agent 0.2.13 aus `main` aktualisieren. Das MGU-Store-Repository baut die Pakete mit dem SDK der Zielumgebung.

Bei eingeschaltetem Fahrzeug die aktiven Meldungen in **Fehler** mit den tatsächlich angezeigten iDrive-Meldungen vergleichen. Eine Meldung unter normalen Betriebsbedingungen erlöschen lassen und prüfen, ob sie in den Verlauf wechselt. Anschließend nach MGU-Neustart und bei getrennter Verbindung den Status prüfen. Bei einer Abweichung den Export unter **Fahrzeug → Technische Fahrzeugdaten-Diagnose** privat sichern. Relevant sind der `basicList:getter`-Eintrag, die zuletzt empfangenen Events, die Provider-/Kombinationsfähigkeiten und die Antwort von `requestCCMessage`.

Eine echte Installation auf der Ziel-MGU, ein SOME/IP-Livemitschnitt und der direkte iDrive-Vergleich lagen für diese Prüfung nicht vor.


## Fahrzeugnachtest vom 27.11.2026

iDrive zeigte „AdBlue Reserve.“ Der BMW AI Assistant zeigte einen fehlgeschlagenen `basicList`-Getter und fehlende Manifestfreigaben für die beiden KOMBI-Getter. Der Kilometerstand und ein Fehlerspeicherscan funktionierten. Aus den Fotos geht weder der genaue Rückgabefehler des SOME/IP-Proxys noch die OAP-Freigabe für `ccList` hervor.

Vehicle Data 0.2.11 unterscheidet im Export `poll.stages["CheckControlMaster.basicList"].getterFailure` zwischen Proxy-Zeitüberschreitung, lokalem Zeitlimit, nicht erreichbarem Provider, verweigertem Zugriff, fehlendem generierten Getter und einem sonstigen Proxy-Fehler. Die Klassifizierung basiert auf der Rückmeldung des Proxys. Die App kann eine Getter-Antwort weiter auswerten, auch wenn während des Abrufs ein leeres oder vollständig verworfenes Event eingetroffen ist. Ein tatsächlich angewendetes Statusereignis hat weiter Vorrang. Der Pi und der Companion Agent können auf 0.10.14 und 0.2.13 bleiben.

Die lokal vorliegende BMW-App `x_call` fordert `KombiInterface_2.ccList` lesend auf Instanz 1 an. Der kombinierte generierte Berechtigungsstand und ein Fahrzeugantwort-Mitschnitt fehlen weiterhin. Der normale Store-Bau behält das bestehende Pflichtmanifest. Für einen Test mit den Referenzen der Ziel-MGU prüft der Paketbau genau den ausgewählten zusätzlichen Getter und das Gesamtmanifest:

```sh
python3 tools/build_store_app.py vehicle_data \
  --catalog "$TARGET_CATALOG" --app-management "$TARGET_APP_MANAGEMENT" \
  --uid "$VEHICLE_DATA_UID" --check-control-getter ccList
```

`VEHICLE_DATA_UID` ist die numerische OAP-ID der Zielinstallation. Das lokale Paket erhält den Dateisuffix `-ccList`. Bei einer Generator-Ablehnung oder fehlenden Firmware-Datei bricht der Bau vor dem Verpacken der zielgebundenen Variante ab. Die Tests prüfen mit einem Generator-Testdoppel, dass eine Freigabe nur den gewählten Getter ergänzt und eine Ablehnung kein geändertes Manifest erzeugt. Um die tatsächliche Freigabe zu prüfen, genügt zunächst der private Diagnoseexport bei erreichbarer Ziel-MGU. Relevant sind `capabilities.rows` für `ccList` und `ccListRiskClass` sowie die Check-Control-Empfangsbelege.

## Vertiefte Quellenprüfung nach Vehicle Data 0.2.11

Geprüfter Quellstand ist `000e98b`. Als Fahrzeugbeobachtung liegt der Abgleich der Bildschirmfotos vor. Im iDrive ist „AdBlue Reserve“ sichtbar. Der BMW AI Assistant meldet einen fehlgeschlagenen `basicList`-Getter und fehlende Manifestfreigaben für die KOMBI-Getter. Der öffentliche Quellstand und das private Diagnose-Repository enthielten keinen auswertbaren Vehicle-Data-0.2.11-Export. Aus der Bildschirmmeldung allein bleibt die Unterscheidung zwischen Timeout, Provider-, Berechtigungs- und Proxy-Fehler offen, ebenso der Zustand der Subscription.

### Vergleich mit BMW x_call

- Das Manifest von `x_call@4.25.3` fordert `KombiInterface_2.ccList` lesend auf Instanz `1` an. Der Aufrufpfad `reloadCheckControlMessages` verwendet den Getter über den typisierten Proxy. Die SDK-Schicht liest die generierte Interface-JSON, initialisiert den nativen Proxy und wartet auf den Provider. Der Getter delegiert an das native `getValue`. Die App liest die ID aus `cCListElement.cCIdentifer` und übernimmt `cCColor`.
- Die App-Bibliothek bietet einen separaten Subscription-Pfad. Das archivierte Manifest fordert für `ccList` ausschließlich `r` an und belegt damit keine freigegebene Subscription. Der bereitgestellte SOME/IP-Katalog führt den Notifier zwar auf, die generierte Konfiguration und die AppManagement-Freigaben der Ziel-MGU lagen hier jedoch nicht vor. Die Berechtigung der BMW-App belegt keine Berechtigung für Vehicle Data.
- Vehicle Data 0.2.11 kann denselben Getter bereits verarbeiten, wenn der BMW-Generator ihn für das Paket freigibt und erzeugt. Der bestehende lokale Bau mit `--check-control-getter ccList` bleibt der Weg für das zielgebundene Paket. `ccListRiskClass` ist im Katalog definiert, kommt im Check-Control-Lesepfad von `x_call` aber nicht vor.
- `newCCMessage` liefert eine Nachricht ohne einen vollständigen Aktivstatus. `requestCCMessage` benötigt eine bekannte Meldungs-ID und dient der Textanreicherung. Im Fehlerfall von `basicList` lässt sich die aktive Menge aus diesen beiden Quellen allein nicht ableiten.

### BMW-PRGs und lokale Textreferenzen

| Referenz | Statischer Befund | Eignung für den Live-Status |
| --- | --- | --- |
| `KOMBSP18.prg`, `KOMBSP21.prg`, `KOMB_G11.prg` | `SG_FUNKTIONEN` führt `BMW_CC_DATENSAETZE` unter Dienst `22`, DID `0xD12D`. `RES_0xD12D_D` beschreibt 25 Datensätze mit ID, Kilometerstand bei Speicherung, Relativzeit und Häufigkeit. `KOMBSP18` hat zusätzlich den Job `STATUS_CHECK_CONTROL_HISTORY`. | Historische Datensätze ohne belegtes Aktiv-/Inaktiv-Feld. |
| `KOMBSP21.prg` | `SG_FUNKTIONEN` nennt `READ_DISPLAYED_CC` unter Dienst `22`, DID `0x400F`. `RES_0x400F_D` beschreibt Layoutversion `0x02`, 66 Byte `CCM_HmiData`, ein Sprachbyte und einen Reservebereich. | Kandidat für das gerade dargestellte Element am KOMBI. Die genaue Struktur von `CCM_HmiData`, Zuordnung von Meldungs-ID, Status und Warnfarbe sowie die Unterstützung am Ziel-KOMBI sind offen. Der Job belegt keine Liste aller aktuell aktiven Meldungen. |
| `BDC_G05.prg` | `LWR_MODUS` (`0xD57E`) beinhaltet einzelne Lichtstatus-Bits. `RSRS_WARNING_STATUS` (`0xCFFD`) betrifft RSRS-spezifische Warnbedingungen. | Keine allgemeine Check-Control-Liste. |
| `HU_MGU.prg` | Datei in den verfügbaren Archiven nicht enthalten. `hu_mgu.plist` aus den vorhandenen Fehlertext-Referenzen enthält UDS-DTC-Texte. | Für die Prüfung wäre die zur Zielsoftware passende `HU_MGU.prg` nötig. |

Die lokalen PRGs, das verfügbare `x_call`-Paket und der SOME/IP-Signalkatalog belegen keine eindeutige lokale Zuordnung für „AdBlue Reserve“. Für den UDS-Kandidaten fehlt die BMW-HMI-Schnittstellendefinition `CCM_HmiData` für Layout `0x02`. Für eine Textdatenbank fehlen die zu CC-IDs gehörigen Original-HMI-Texte oder Fahrzeugantworten mit ID und Originaltext. DTC- und Servicecode-Referenzen bleiben getrennt.

### Automatisierte Prüfung und Fahrzeugabnahme

`npm test`, `npm run test:pi`, `python3 tests/test-someip-manifest.py` und der lokale Store-Bau für Vehicle Data 0.2.11 waren erfolgreich. Die Generator-Tests prüfen mit einem Testdoppel, dass der Paketbau bei einer abgelehnten Freigabe abbricht. Der reale BMW-Generator der Ziel-MGU fehlte für diese Prüfung.

Es wurde kein weiterer Getter in das Standardmanifest aufgenommen und kein UDS-Fallback aktiviert. Damit bleiben Vehicle Data 0.2.11, Companion Agent 0.2.13 und Pi 0.10.14 die Paketstände. Relevant für den nächsten Vergleich sind im privaten JSON-Export `poll.versions`, `poll.stages`, `checkControl.receipts` und `capabilities.rows` für die Check-Control-Quellen. Der Export liefert den Getter-Fehler und, falls der BMW-Generator zugänglich ist, die zielbezogene Getter-Prüfung. Eine positive Generator-Prüfung muss durch eine echte `ccList`-Antwort mit ID und Text bei sichtbarer iDrive-Meldung ergänzt werden. Anschließend ist der Übergang zu „erloschen“ im normalen Fahrzeugbetrieb zu prüfen.
