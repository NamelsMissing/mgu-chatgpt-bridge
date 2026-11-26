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
