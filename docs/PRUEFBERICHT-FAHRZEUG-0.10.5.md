# BMW AI 0.10.5 – Fahrzeug und Wartungsplanung

Der Raspberry-Pi-Server und die Weboberfläche wechseln von 0.10.4 auf 0.10.5. Vehicle Data 0.2.6 und Companion Agent 0.2.10 benötigen dafür kein Update. Das Pi-Update verwendet die bestehende Signierung und Dateiliste.

## Oberfläche und Datenhaltung

- Die Fahrzeugseite zeigt Übersicht, Wartung, Servicehistorie, Reifen und DPF. Kilometerstandeingabe, Verlauf, Wartungseinstellungen, Service-Details und DPF-Regenerationen sind aufklappbar. Die frühere zusätzliche BMW-Historienliste entfällt.
- Unter **Diagnose → Fahrzeugdaten** stehen Signalstufen, Versionen, Übertragungsstatus, DPF-Feldzeitpunkte und der bereinigte JSON-Export bereit.
- Das Profil **BMW G21 Diesel** ergänzt nach Auswahl Motoröl und Ölfilter, Mikrofilter, Fahrzeug-Check, Motorluftfilter, Dieselkraftstofffilter, Bremsflüssigkeit, Kühlflüssigkeit und HU/AU. Kühlflüssigkeit alle 36 Monate ist eine Vorsorgeeinstellung. BMW-orientierte Planungswerte können angepasst werden. Verschleißteile erhalten kein pauschales Intervall.
- Eindeutig als durchgeführt oder verspätet durchgeführt gekennzeichnete BMW-Historienpositionen werden pro Wartungsart ausgewertet. Bei unbekanntem Wechsel bleibt der Plan offen. Für Bremsflüssigkeit und HU/AU ergibt sich im G21-Profil der erste Termin 36 Monate nach eingetragener Erstzulassung, danach aus der dokumentierten Durchführung im 24-Monats-Rhythmus. Ein Ölwechsel erzeugt keine weiteren Wartungsnachweise. Unbekannte Servicecodes bleiben sichtbar.
- Bereits vorhandene Pläne, darunter das individuelle Ölintervall von 8.000 km und zwölf Monaten, behalten ihre Werte. CBS und berechnete oder individuelle Fälligkeit sind getrennt sichtbar. Die Zusammenführung der Historie ist eine Anzeigeoperation. Vorhandene Einträge werden nicht gelöscht.
- Ein historischer Servicekilometerstand fließt in die nachvollziehbare Fahrleistungsprognose ein. Für den aktuellen Kilometerstand und die Restkilometer gelten Fahrzeugmessung oder manuelle Angabe. Ein höherer manueller Eintrag darf die Übernahme eines plausiblen echten Fahrzeugwerts in den Verlauf nicht blockieren.
- Die Installation speichert weiterhin den Plan für die gekoppelte MGU. Eine automatische Trennung mehrerer Fahrzeuge erfordert eine bestätigte fahrzeugspezifische Zuordnung und ist offen.

## Quellen und offene Fahrzeugtests

| Bereich | Vorhandener Datenpfad | Befund |
| --- | --- | --- |
| Kilometerstand | `SecureMileage.mileage`, `MileageSupreme.mileageSupreme` über Vehicle Data und den Snapshot | Getter und Subscription existieren im Pflichtmanifest, der Decoder verlangt die bekannten Mitglieder und bei MileageSupreme den Verfügbarkeits-Qualifier. Ohne Rohwert vom Zielgerät lässt sich zwischen fehlendem Provider, fehlender Antwort und nicht erkannter Struktur nicht entscheiden. `VehicleInformation.Range` ist weiterhin keine Pflichtanforderung. Kein alternativer DID wurde verifiziert. |
| CBS | Bestehende Legacy-Events und optional der kompatibilitätsabhängige `KombiInterface_2.cbsDataServiceList` | Berechnete Fälligkeiten funktionieren aus eindeutiger Historie und Plan. Die Vollständigkeit aktueller CBS-Daten hängt weiterhin von den tatsächlich beantworteten MGU-Signalen ab. |
| Servicehistorie | `ServiceHistory.readServiceHistory` über die bestehende Pipeline | Die gemeldete Aufnahme zeigt vorhandene BMW-Einträge. Ohne exportierte Einzelpositionen lassen sich für dieses Fahrzeug keine konkreten Wechsel oder Termine bestätigen. |
| Reifen | `TPMSInternalData.tpmsInternalLastValues` und Diagnoseproben für optionale TPMS-Getter | Der vorhandene Decoder verwendet die in den Feldnamen angegebenen mbar und °C. Anzeige und Aktualität wurden mit Testdaten geprüft. Direkte RDC-Werte und alternative RDC-Diagnose sind am Zielgerät unbestätigt. |
| DPF und Fehler | Bestehende lesende Diagnose | Die gemeldeten DPF-Werte und Fehlercodes belegen frühere Fahrzeugempfänge. Tests prüfen die bestehende Verarbeitung und Fehlertextdatenbank. Die Version wurde am Fahrzeug nicht getestet. |

Belastbare Fahrzeugprüfung nach dem Pi-Update:

1. Im Wartungsplan das G21-Diesel-Profil wählen und die tatsächliche Erstzulassung eintragen.
2. Dokumentierte Servicepositionen, insbesondere Bremsflüssigkeit und Kühlmittel, in der gemeinsamen Historie mit iDrive abgleichen.
3. Bei eingeschalteter MGU Kilometerstand und bei aktiver iDrive-RDC-Anzeige die vier Räder vergleichen. Bei fehlenden Werten den privaten JSON-Export unter **Diagnose → Fahrzeugdaten** sichern. Provider, Getter, Abo, Rohwert, Decoder und Pi-Übernahme getrennt prüfen.
4. MGU-Verbindung unterbrechen und wiederherstellen. Gespeicherte Werte müssen erhalten bleiben und werden bis zu einer neuen gültigen Messung als veraltet angezeigt.

## Prüfungen

- Repository-Suiten `npm test`, `npm run test:pi`, MotorScope-Import, SQLite-Referenz und SOME/IP-Validator.
- Chromium mit Desktop-, iPhone- und iPad-Profilen gegen den lokal laufenden Pi-Server mit Testdaten, einschließlich gemeinsamem Verlauf und Diagnosewechsel. Kein Test auf physischen Mobilgeräten.
- Vehicle-Data-Store-Build 0.2.6 einschließlich Autostart-Prüfung. Der Validator meldet ohne den Zielkatalog ausdrücklich „nicht verifiziert“.
- Keine Installation im BMW und keine neuen Live-Messungen. Der signierte Pi-Release läuft über die GitHub-Release-Pipeline.
