# BMW AI 0.10.4 · Private SQLite-Fehlertextreferenz

## Installation

1. Pi auf 0.10.4 aktualisieren. Vehicle Data und Companion Agent bleiben unverändert. Die neue Funktion benötigt Python 3 mit dem Standardmodul `sqlite3` auf PC und Pi. Sie benötigt kein natives Node-Zusatzmodul.
2. Auf Windows das Repository beziehen und in PowerShell aus dessen Verzeichnis ausführen:

   ```powershell
   py -3 pi-source/dtc-reference.py "C:\Privat\bmw-fehlertext-referenzen.zip" "C:\Privat\dtc-reference.sqlite" --report "C:\Privat\importbericht.json"
   ```

   Auf Linux denselben Aufruf mit `python3` statt `py -3` verwenden. Das Zielverzeichnis muss existieren. Der Import verweigert Überschreiben. Die in der privaten Entwicklungsumgebung bereits erzeugte SQLite-Datei kann ebenfalls verwendet werden.

3. Importbericht prüfen. Unter **System → Fehlertextdatenbank** die SQLite-Datei auswählen und **Validieren und installieren** anklicken. Der Pi streamt bis 192 MiB in eine temporäre Datei, prüft das unterstützte Schema, Daten und SQLite-Integrität im separaten Python-Prozess und aktiviert die geprüfte Datei atomar. Die vorige Datenbank bleibt als eine wiederherstellbare Sicherung erhalten. Der Download des Berichts liefert Metadaten, keine Datenbank.
4. **Fehler** öffnen. Gespeicherte Codes werden auch bei ausgeschalteter MGU aufgelöst. Bei Bedarf ein früheres Fahrzeugarchiv auswählen. Titel aus globalen oder adressbezogenen Übereinstimmungen zeigen die geringere Zuordnungsqualität. Widersprüche sind ausklappbar. Eine aktive Warnung kommt weiterhin aus den Fahrzeug-Statusbits.
5. Ein MotorScope-JSON kann weiterhin über den bisherigen privaten Import genutzt werden. Für einen kombinierten SQLite-Katalog zuerst das bestehende CLI `pi-tools/import-motorscope-dtc.mjs` mit bestätigter ECU-Datei ausführen. Dann:

   ```powershell
   py -3 pi-source/dtc-reference.py merge-motorscope Basis.sqlite konvertierte-texte.json Kombiniert.sqlite de
   ```

   Sprache `de` oder `en` anhand des Exports auswählen. Beide Quellen bleiben unterscheidbar. Bei Konflikten auf derselben SQLite-Lookup-Stufe erscheinen Kandidaten.

## Referenz und Datenbank

| Messgröße | Ergebnis |
| --- | ---: |
| Fehler-PLIST-Dateien | 861 |
| Variantenzeilen | 1.307 |
| Unterschiedliche Variantenreferenznamen | 1.025 |
| Variantenreferenznamen ohne zugehörige Datei | 164 |
| Sechsstellige Vorkommen unter `errors` | 138.717 |
| Unterschiedliche sechsstellige Fehlercodes | 57.293 |
| Unterschiedliche deutsche Titel pro Code, exakt verglichen | 13.527 Konfliktcodes |
| Deutsche Übereinstimmung nach Vereinheitlichung von Leerraum | 43.814 Codes |
| Deutsche Konflikte nach Vereinheitlichung von Leerraum | 13.479 Codes |
| Importierte deutsche / englische Texte, inklusive getrennter Info- und Kurzcode-Kategorien | je 297.387 |
| Technische Langbeschreibungen in den PLISTs | 0 |
| SQLite-Datengröße | 106.446.848 Bytes |
| Lokaler Lookup für 1.000 reale Codes in einer Verbindung | 7,9 ms, Prozessspitze 16.256 KiB |
| Synthetische 150.000 Textzeilen | 14.225.408 Bytes, 1.000 Lookups ca. 8 ms |

`ecu-variants.plist` liefert `descriptionFilename`, `group`, `addressIndex` und `UDS`. Der Import erhält die vollständige Adress-/Indexangabe und verwendet die führenden zwei Hexzeichen für die Diagnoseadresse. Er verknüpft `descriptionFilename` mit dem PLIST-Dateinamen ohne Erweiterung. `errors` und `infoErrors` sowie unterschiedliche Codebreiten bleiben gespeichert. Nur exakt sechsstellige `errors` werden für die UDS-Anzeige herangezogen. Führende Nullen bleiben erhalten. Sechs ungültige Platzhalter wurden ausgelassen. BMW-Titel bleiben original gespeichert. Für die Konsensprüfung wird ausschließlich Leerraum vereinheitlicht.

Schema 1 enthält `imports` mit Quelle, Version, Zeitpunkt und Bericht, `variants` mit Referenz, Familie, Diagnoseadresse, Protokoll und Originalindex und `texts` mit Codes, Kategorien, Sprache, Titel, optionaler Beschreibung, Quelle und Verifizierungsflag. Indizes decken Code, Referenz, Familie und UDS-Adresse ab. Python fragt nur die Codes des anzuzeigenden Berichts ab. Die Datenbank liegt unter `DATA_DIR/dtc-reference.sqlite`. Bestehende ECU-Identitäten und historische Scans verbleiben im privaten Pi-Zustand. Alte und neue Kopplungen erhalten getrennte Fehlerspeicher. Bestätigte Zuordnungen können je Scan eingefroren werden. Die Kopplung ist die lokale Trenninformation und ist keine FIN. Bei unbestätigter Identität ist die Auflösung Referenzkonsens. Ein Retrofit-Code kann ohne Konfigurationsänderung über Adresse oder globalen Konsens erscheinen.

Die öffentliche Release-ZIP behält die erlaubte Dateiliste. Das Python-Programm wird in die Serverdatei eingebettet. Die private SQLite-Datei bleibt von Updates getrennt. Die Chat-Auswertung verwendet nur die ausgewählten Titel eines ausdrücklich freigegebenen Scanauftrags und übergibt dessen Zuordnungsqualität.

## Prüfumfang und Grenzen

- Mit **echtem Referenzarchiv** importiert, SQLite-Integrität geprüft und Stichproben nachgeschlagen. Der Katalog zeigte unter den früher diskutierten Code/Adresspaaren für 801C10 und 29FB00 mehrere Kandidaten, für B7F500 eine Adressübereinstimmung. Das sind Referenzergebnisse ohne Bestätigung der ECU-Variante am Auto.
- Automatisierte Tests verwenden frei erstellte Daten für XML- und Binär-PLIST, ungültige Archive und Datenbanken, führende Nullen, Konsensstufen, Konflikte, MotorScope-Ergänzung und 150.000 Zeilen. Der Pi-Monitortest prüft authentifizierten Upload, fehlerhafte Installation, Wiederherstellung und Offline-Auflösung. Testsuite und Release verwenden keine BMW-Referenzarchive.
- Pi-Laufzeit und Lookup wurden in der Entwicklungsumgebung getestet. Eine Prüfung auf echter Raspberry-Pi-Hardware oder am BMW wurde nicht durchgeführt. Das gemessene Lookup-Timing enthält weder Prozessstart noch Browser-Rendering.
- Automatische SGBD-, Hard- und Softwareidentifikation wurde nicht um neue UDS-DIDs erweitert. Ein Steuergerätetausch oder Softwarewechsel bei unveränderter Kopplung erfordert bestätigte Identitätsdaten, bevor eine neue exakte Zuordnung möglich ist. Bereits beim Scan festgehaltene Identitäten bleiben vorhanden. Es gibt keine neue ECU-Schreibfunktion.
- ISTA-Dateien und die erwähnten ISTA-JSON-Exporte lagen nicht vor. Ein ISTA-spezifischer Import bleibt offen. Die dokumentierten Einschränkungen für Kilometerstand, CBS, Check-Control und RDC aus 0.10.3 bleiben bestehen.
