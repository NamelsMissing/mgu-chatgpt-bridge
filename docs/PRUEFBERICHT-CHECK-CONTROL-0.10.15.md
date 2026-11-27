# Check-Control · Empfangene Meldungen aus Vehicle Data

Ausgangsstand `826fc3f`. Vehicle Data steigt von 0.2.11 auf **0.2.12**, der Pi von 0.10.14 auf **0.10.15**. Companion Agent 0.2.13 überträgt bereits alle Einträge von `checkControl.events` und bleibt auf diesem Stand.

## Fahrzeugbeobachtung und Ursache

Im vom Nutzer zitierten Diagnoseausschnitt vom 27.11.2026 um 06:17:06.332 UTC empfing `KombiInterface_2.newCCMessage` die BMW-Meldung **646 / 0x0286 „AdBlue Reserve.“** mit BMW-Farbe `WHITE`. Decoder, Empfang und Text stimmen mit der iDrive-Beobachtung überein. Der Notifier enthält kein Aktivstatusfeld. In 0.2.11 landete der Text nur in der Empfangsdiagnose und der lokalen Textanreicherung. Die normalen Ereignisse und die aktive Liste blieben leer. Die separat erwähnte vollständige JSON-Datei war im Workspace nicht verfügbar. Die Regressionstests verwenden die oben dokumentierte, anonymisierte Projektion des mitgeteilten Befunds und synthetische Folgeantworten.

`CheckControlMaster.basicList` hatte laut Ausschnitt Manifest- und generierte Getter-Berechtigung, eine erfolgreiche Einrichtung der Subscription und einen nach Fehlern pausierten Getter. Die 0.2.11-Klassifizierung `provider_unavailable` erfasste auch generische native Fehler wie „Value not available“. Sie belegt für sich keine Provider-Abwesenheit. 0.2.12 unterscheidet einen ausbleibenden Availability-Status, explizite Servicefehler im Proxy sowie generische native Antworten, Rechtefehler und Timeouts. Bei fehlender Provider-Verfügbarkeit wartet der Check-Control-Getter auf ein Availability-Ereignis. Die Subscription bleibt eingerichtet. Bei wiederholten Getter-Fehlern und weiterhin angebotenem Dienst folgt ein Backoff.

## Umsetzung

- Gültige `newCCMessage`-Ereignisse werden mit Zeit, ID, Text und Metadaten übertragen. Der Aktivstatus bleibt `null`. Vehicle Data kann für dieselbe ID einmal gezielt `requestCCMessage` aufrufen und eine passende Beschreibung ergänzen.
- Pi 0.10.15 übernimmt auch den letzten gültigen, bereits gespeicherten Empfangsbeleg von Pi 0.10.14. Unbestätigte Ereignisse erscheinen in der **Fahrzeugübersicht**, unter **Fehler → Check-Control** und im Verlauf. Eine spätere bestätigte Zustandsmeldung oder vollständige Liste löst die vorläufige Anzeige ab. Ein alter oder fehlender Empfang wird als zuletzt bekannt gekennzeichnet. Unbestätigte Meldungen erhöhen den aktiven Fehlerzähler nicht und lösen keine Push-Warnung aus.
- Der Pi speichert empfangene Ereignisse im vorhandenen lokalen Monitorzustand dauerhaft und erkennt die Wiederholung desselben Ereignisses am Zeitstempel und der ID. Die Oberfläche zeigt einen Ausschnitt des Verlaufs. Vehicle Data übernimmt beim Neustart ungelesene Empfangsereignisse aus seinem letzten lokalen Snapshot. Der Agent überträgt wie bisher die letzten 50 Snapshot-Ereignisse. Ereignisse außerhalb dieses Fensters können bei einer langen Unterbrechung verloren gehen, wenn der Pi sie vor der Unterbrechung noch nicht erhalten hat.
- Empfangene BMW-Texte werden separat in `checkControlReferences` im privaten Pi-Datenbestand abgelegt. Die Referenzen enthalten keine Aktivstatusentscheidung. Die BMW-Farbe `WHITE` bleibt sichtbar, ohne ihr eine Warnschwere zuzuweisen.
- Der Diagnoseexport prüft die SQLite-DTC-Referenz separat. `database_missing` beziehungsweise null geladene Texte aus der früheren Ausgabe bezogen sich auf die optionale alte JSON-Datenbank. Der Reparaturstand weist die SQLite-Verfügbarkeit unabhängig aus. Der Zustand der SQLite-Datei auf diesem Fahrzeug-Pi lässt sich aus dem bisherigen Ausschnitt nicht ablesen. Es wurden keine Datenbanken verändert.

## Freigabe für die vollständige Liste

Laut Auszug war der `KombiInterface_2`-Provider erreichbar, und `newCCMessage` lieferte eine Antwort. Die Getter `ccList` und `ccListRiskClass` fehlten im installierten Manifest. Die BMW-App `x_call@4.25.3` belegt die Verwendung des `ccList`-Getters auf Instanz 1 für diese BMW-App. Der AppManagement-Generator und die tatsächlich generierte Proxydatei der Ziel-MGU waren im Workspace nicht verfügbar. Eine reguläre Freigabe für Vehicle Data lässt sich deshalb hier nicht bestätigen.

Das Standardpaket hat das bisherige Pflichtmanifest. Wenn der BMW-Generator `ccList` für die Ziel-MGU bestätigt, erzeugt der bestehende lokale Bau mit `--check-control-getter ccList` eine separat benannte Variante. Der Bau prüft den einzelnen Getter und das Gesamtmanifest. Weitere Getter werden dabei nicht angefordert. Das Standardpaket nutzt weiterhin die vorhandene Subscription und die bisherigen lesenden Schnittstellen. Ein UDS-Fallback wurde nicht aktiviert.

## Weitere Befunde aus dem zitierten Export

- KOMBI `0xD10D` auf ECU `0x60` meldete laut Nutzerauszug **98.571 km** in RAM und EEPROM. Aus `MileageSupreme` ergibt sich rechnerisch `98571230 / 1000 = 98571,23`. Der Zielkatalog definiert dort `UInt32` und den Qualifier, aber keine Einheit. Ein einzelner Vergleich belegt die Skalierung nicht. Die Kilometerstandsabfrage und ihre Decoder wurden nicht verändert.
- Der Agent projiziert die installierten Versionen aus den lokalen Paketmetadaten und nimmt für den Status den neuesten gültigen Snapshot mit Heartbeat. Die Liste mit 0.2.0, 0.2.4 und 0.2.11 allein belegt keine parallel laufenden Altversionen. Zur Prüfung wären die jeweiligen Snapshot- bzw. Heartbeat-Zeiten oder die laufenden Prozesse erforderlich. Es wurden keine Altinstallationen gelöscht.

## Prüfungen und nächster Fahrzeugtest

Lokal bestanden `npm test`, `npm run test:pi`, Manifest- und Referenzdatenbanktests, Syntaxprüfung mit Node 8.7 und der Store-Paketbau. Die Tests prüfen die Wiederherstellung eines Altbelegs, die Weiterleitung durch Agent 0.2.13, Offline-/Neustartverhalten, spätere Listenzustände, den Schutz vor doppelten Meldungen sowie die getrennte SQLite-Erkennung.

Am Fahrzeug nach Aktualisierung von Pi und Vehicle Data prüfen, ob „AdBlue Reserve.“ mit dem tatsächlichen Empfangszeitpunkt im Verlauf erscheint. Stimmen die IDs des Notifiers und einer später freigegebenen Liste überein, kann die Meldung als bestätigt aktiv gezeigt werden. Ein erneuter bereinigter Export belegt zusätzlich den Methodenabruf, die Availability des ursprünglichen Providers und die Zielgeräteprüfung für `ccList`. Die vollständige Liste und der Methodenabruf wurden mit dieser Version noch nicht am Fahrzeug getestet.
