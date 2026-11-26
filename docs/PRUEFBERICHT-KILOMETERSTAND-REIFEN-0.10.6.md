# BMW AI 0.10.6 – Kilometerstand und Reifendaten

| Komponente | Vorher | Neu |
| --- | --- | --- |
| Vehicle Data | 0.2.6 | 0.2.7 |
| Companion Agent | 0.2.10 | 0.2.11 |
| Raspberry Pi | 0.10.5 | 0.10.6 |

## Erfassung und Darstellung

- Kilometerstand. Gültige aktuelle SOME/IP-Daten haben Vorrang. Wenn diese ausbleiben, fragt Vehicle Data den Kilometerstand über den bestehenden TASU-Transport am Motorsteuergerät 0x12 per UDS 0x22, DID 0x558E ab. Das vier Byte lange Ergebnis liefert Kilometer. Null, außerhalb des plausiblen Bereichs liegende Werte, negative Antworten und abweichende Formate werden verworfen. Die Website zeigt Quelle und Messzeit.
- Reifen. Wenn keine frische vollständige SOME/IP-Messung vorliegt, liest Vehicle Data am RDC 0x29 je eine definierte Kennung von 0xDC98 bis 0xDC9B für die vier Radpositionen. Der Parser prüft die positive Antwort und die erwartete Länge von 24 Nutzbytes. Er verarbeitet Ist- und Solldruck in mbar und die Temperatur in °F. Die Website zeigt bar und °C sowie die Abweichung vom Sollwert an. Ungültige Werte bleiben leer. Unbekannte RDC-Statusbits und die Sensor-ID werden nicht verwendet.
- Die Fallbacks teilen den bestehenden Diagnosetransport mit DPF und Fehlerspeicher. Kilometerstand wird bei Bedarf höchstens alle fünf Minuten abgefragt, Reifen höchstens alle zwei Minuten. Die Warteschlange kann zwischen einzelnen Reifenabfragen einem Fehlerspeicherauftrag Vorrang geben. Die bisherigen SOME/IP-Quellen erholen sich nach einer Pause auch bei dauerhaft gemeldetem Provider wieder von transienten Getter-Fehlern.
- Agent und Pi reichen Quellen und Zeitstempel durch. Nach Unterbrechung bleiben letzte gültige Werte als veraltet sichtbar. Die Fahrzeugdaten-Diagnose nennt pro UDS-Leseweg Erfolg, Timeout, negative Steuergeräteantwort oder unpassendes Format. Sie enthält keine RDC-Sensorkennungen.
- Das Pflichtmanifest bleibt identisch zu 0.2.1. Es nutzt die vorhandene TASU-Berechtigung. Die Installation verlangt keine weiteren SOME/IP-Rechte.

## Prüfung

- Der Decoder wurde offline mit 42 veröffentlichten Diagnoseantworten aus einem BMW 3er Modelljahr 2021 geprüft. Die erwarteten Kilometer-, Druck- und Temperaturwerte stimmten überein. Sensor-IDs wurden für die Prüfung aus den Testdaten entfernt. Die Mitschnitte stammen aus dem öffentlichen OBDb-Projekt und nicht vom Ziel-G21. [OBDb-Modelljahr 2021](https://github.com/OBDb/BMW-3-Series/tree/414dd76abbbb592dcd64b486f7d045b9fa4d43e2/tests/test_cases/2021) · [OBDb-Signaldefinitionen](https://github.com/OBDb/BMW-3-Series/blob/414dd76abbbb592dcd64b486f7d045b9fa4d43e2/signalsets/v3/default.json)
- `npm test`, `npm run test:pi`, MotorScope-Import, SQLite-Referenztest und SOME/IP-Validator-Tests bestanden. Die Integration prüft die Übergabe von Messwerten, Quellen und Zeitstempeln über echte Agent- und Pi-HTTP-Prozesse mit Testantworten.
- Store-Build für Vehicle Data 0.2.7 erfolgreich. Das finale Archiv enthält den neuen Decoder und aktiviert Autostart. Kompatibilität gegen den Zielkatalog ist ohne dessen Datei nicht verifiziert.
- Es gab keinen Zugriff auf das Fahrzeug, keine Installation am Ziel-Pi und keinen Live-Vergleich mit iDrive. Die konkrete Ursache des Ausfalls der SOME/IP-Quellen ist daher weiterhin offen. Im privaten MotorScope-Code fand sich kein produktiver Kilometerstand- oder RDC-Decoder für diesen Fall.

## Fahrzeugabnahme

Vehicle Data 0.2.7 und Companion Agent 0.2.11 aus dem MGU Store aktualisieren und das signierte Pi-Update 0.10.6 installieren lassen. Mit aktiver MGU nach etwa zwei Minuten **Fahrzeug** öffnen. Kilometerstand mit dem Kombiinstrument vergleichen. Für die Reifen warten, bis iDrive aktuelle RDC-Werte zeigt, und alle vier Radpositionen vergleichen. Falls ein Wert fehlt, unter **Diagnose → Fahrzeugdaten** den bereinigten JSON-Bericht speichern. Die UDS-Einträge zeigen, ob das jeweilige Steuergerät erreichbar war und welches Antwortformat erkannt wurde.
