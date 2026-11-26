# BMW AI 0.10.10 – Kilometerstand aus KOMBI und BDC

Ausgangsstand ist Pi 0.10.9, Vehicle Data 0.2.7 und Companion Agent 0.2.11. Neu sind **Pi 0.10.10**, **Vehicle Data 0.2.8** und **Companion Agent 0.2.12**. Geändert sind der MGU-Decoder mit Quellenauswahl, Snapshot/Agent-Übergabe, Pi-Übernahme, Webdiagnose und Tests. Die Versionsdateien und der Store-Katalog sind aktualisiert.

## Originalreferenzen

Die sechs PRGs wurden lokal mit den Tabellen- und Jobparsern von MotorScope untersucht. Das Originalmaterial ist außerhalb des Repositories geblieben.

| Referenz und Job | Kennung | Befund |
|---|---|---|
| `KOMBSP18.prg`, `KOMBSP21.prg`, `KOMB_G11.prg`, `STATUS_LESEN` / `SG_FUNKTIONEN` | `D122` | `GWSZ_ANZEIGE_WERT` bzw. `STAT_GWSZ_ANZEIGE_WERT`, Service 22, unsigned long, high, km, Skalierung 1. Erwartet vier Nutzbytes. |
| Dieselben drei KOMBI-Dateien, `RES_0xD10D_D` | `D10D` | Zwei serielle unsigned-long-Felder in der Tabellenreihenfolge RAM und EEPROM, beide high und km. Die generische `STATUS_LESEN`-Auswertung arbeitet mit Ergebnistabelle, Datentyp und Feldposition. Erwartet acht Nutzbytes, RAM ab Byte 0, EEPROM ab Byte 4. Nur RAM dient der Anzeige. Eine Differenz über 50 km erscheint als technischer Hinweis. |
| `BDC_G05.prg` und `BDC.prg`, `STATUS_KILOMETERSTAND` | `1700` | Die Jobanweisung sendet `22 17 00` an ECU 0x40. Nach Entfernen des Transportkopfs prüft sie die positive Antwort und setzt die UDS-Indizes 3 bis 6 mit Schiebeweiten 24/16/8/0 zu `STAT_KILOMETERSTAND_WERT` zusammen. Damit vier Big-Endian-Nutzbytes, ohne zusätzliches Statusbyte im belegten Feld. Der Pi-Pfad verwirft den BMW-Sentinel 0xFFFFFF sowie Werte außerhalb des bestehenden plausiblen Bereichs. |
| `D83BX7C0.prg` und `BDC_G05.prg`, `SG_FUNKTIONEN`, `RES_0x40A3_D` bzw. `RES_0x4824_D` | `40A3`, `4824` | FEPM-Historie. Ein UInt32BE und fünf verkürzte UInt16BE-Felder in km. Erwartet 14 Nutzbytes. Die Historienwerte werden weder zu vollständigen früheren Tachoständen rekonstruiert noch zur Live-Anzeige verwendet. Der separate DDE-Job `STATUS_KILOMETERSTAND` beginnt mit einer dynamischen Definition per Service 2C und wird nicht aufgerufen. |
| Bestehender externer Modelljahr-2021-Mitschnitt | `558E` | Vier Byte, km. In der beigelegten DDE-Tabelle nicht bestätigt und letzter Fallback. |

Bei gültigem, frischem SOME/IP-Wert bleibt dieser vorrangig. Andernfalls versucht die App KOMBI `D122`, KOMBI `D10D` RAM, BDC `1700`, DDE `558E`. Eine erfolgreiche Quelle wird bevorzugt weitergelesen. Negative Antworten wegen fehlender Unterstützung pausieren die jeweilige Abfrage für 30 Minuten. Transiente Fehler werden zeitlich gestaffelt erneut geprüft. App-Neustart, erneute TASU-Verfügbarkeit und die Aktualisierungstaste setzen die Quellenauswahl zurück. Ein separater ECU-Identitätsscan wurde nicht hinzugefügt. FEPM wird bei erfolgloser Live-Kette einmal pro Verfügbarkeitsperiode separat geprüft. Die bestehende Queue behält den Vorrang der Fehlerspeicheraufträge.

Der Pi übernimmt ECU, DID, Quelle und Messzeit, behandelt eigene Angaben separat und schützt die Historie vor Fahrzeugwerten, die er beim Eingang verworfen hat. Der nächste gültige Fahrzeugwert aktualisiert die Restkilometer des vorhandenen Wartungsplans ohne Neuimport. Die Diagnose zeigt pro Kilometerstandspfad NRC, Länge, passende begrenzte Nutzbytes, Zeit, Verfügbarkeit und Fehlergrund. Der automatische GitHub-Bericht übernimmt davon nur die bekannten Statusfelder. Das Pflichtmanifest und der RDC-Decoder wurden unverändert gelassen.

## ServiceHistory-Codes

In `CBSNRTEXT`/ `CBSKENNUNG` und `CBS_7_0_KENNUNG` ist **0x11** Fahrzeug-Check. Das ist dezimal **17**. Für dezimal 11 beziehungsweise 12 (`0x0B` und `0x0C`) enthalten diese Tabellen keine Zuordnung. Die DDE-Referenzen zu Luftfilterdruck und Kraftstofffilterheizung sind Mess- bzw. Fehlerspeicherdaten und belegen keine ServiceHistory-Position. Ein CBS-Typ darf zudem nicht pauschal mit dem numerischen Typ von `serviceEntries[].serviceText` gleichgesetzt werden.

Der vorhandene ServiceHistory-Decoder erkennt bestätigte BMW-Codes nun auch dann, wenn das SDK sie als Dezimalstring liefert. Bereits gespeicherte bekannte Planpositionen wie Code 17 erscheinen mit deutschem Titel und werden ohne neuen Scan ausgewertet. Die Originalcodes bleiben in den Details erhalten. 11 und 12 bleiben unaufgelöst. Benötigt wird aus **der Ziel-MGU** die Typdefinition von `ServiceHistory.readServiceHistory → dataSets[].serviceEntries[].serviceText`. Geeignet sind `/etc/oap/someip/someip-interfaces.json` mit den referenzierten Typen oder die erzeugte Proxy-Datei `someipInterfaces/com_harman_infotainment_systemfunctions_servicehistory_ServiceHistory.json` des Vehicle-Data-Pakets, sofern sie die Enumwerte enthält. Alternativ eignet sich die originale `ServiceHistory.fidl` samt importierter Enum-Datei derselben Firmware. Ein bereinigter Mitschnitt mit Zuordnung der fraglichen Position zum iDrive-Text kann zusätzlich bestätigen, welcher Typ tatsächlich geliefert wird.

## Prüfungen und Installation

- PRG-Befunde sind statisch bestätigt. Synthetische Tests prüfen 98.181 km, RAM/EEPROM-Differenz, BDC-Sentinel, Länge, Header, NRC, Timeout, Quellenauswahl, FEPM-Trennung sowie bekannte und unbekannte Servicecodes. Die HTTP-Integration prüft den Konflikt mit einer höheren manuellen Eingabe und die Neuberechnung der Öl-Restkilometer.
- Repository-Suiten und ergänzende Referenztests, Syntaxprüfung der geänderten MGU-Dateien unter Node 8.7, MGU-Store-Paketbau und Autostart-Prüfung. Ohne Zielkatalog bleibt die Store-Kompatibilität am konkreten Gerät separat zu prüfen.
- Vehicle Data und Companion Agent aus dem MGU Store aktualisieren und das signierte Pi-Update installieren lassen. Kilometerstand mit dem Kombiinstrument vergleichen. Falls kein Wert erscheint, den bereinigten Export unter **Diagnose → Fahrzeugdaten** sichern.
- Keine Live-Messung am Ziel-G21. Die Ursache des bisherigen Ausfalls einzelner SOME/IP-/DDE-Pfade lässt sich erst aus einer Zielantwort oder dem Diagnoseexport bestimmen.
