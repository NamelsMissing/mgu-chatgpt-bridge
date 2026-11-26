# BMW AI 0.10.13 – ServiceHistory-Wartungsberechnung wiederherstellen

0.10.11 und 0.10.12 delegierten numerische ServiceHistory-Codes an eine Datenbank ohne Einträge für diesen Namensraum. Ausgangsstand für die Migration ist das Pi-Datenformat von 0.10.10. Die korrigierte Pi-Version 0.10.13 lädt die ServiceHistory-Referenz 1.2.0. Vehicle Data und Companion Agent bleiben auf ihren bestehenden Versionen.

## Quellen und Regeln

Der BMW-Zielkatalog definiert ServiceEntriesStruct.serviceText als UInt8 ohne Enum. CBS-KOMBI-Tabellen und IDScopeCBS bestätigen einzelne Bezeichnungen in ihren jeweiligen Namensräumen. Die Zahlen werden getrennt gespeichert.

Die veröffentlichte ServiceHistory-Tabelle von BimmerGuide enthält 37 Codes. Der Vergleich mit ServiceManager berücksichtigt dessen Code-Enum und Anzeigetexte. 33 ServiceHistory-Codes sind mit extern dokumentierter Bedeutung auswertbar, drei bleiben interne oder reservierte Werte und einer ist mehrdeutig. ServiceManager und BimmerGuide widersprechen sich bei Code 5 (Umluftfilter beziehungsweise Service Inclusive). Code 21 wird als Einfahrkontrolle angezeigt. Das ist die spezifische Bezeichnung bei BimmerGuide, gestützt durch die KOMBI-CBS-Referenz. ServiceManager verwendet die breitere Bezeichnung Service Inspection. Codes 11 und 12 bezeichnen Motorluftfilter und Kraftstofffilter in beiden externen Quellen. Bei Code 35 ist die Getriebeart offen. Code 9 bezeichnet QMV-H-Öl und wird keinem Hinterachsgetriebe zugeordnet. [BimmerGuide](https://www.bimmerguide.de/service-historie-eintrag-mit-tool32/) · [ServiceManager-Enum](https://github.com/theDeniZ/ServiceManager/blob/d014ade949b1b485699a7b024815d1d19df583a9/serviceitem.h) · [ServiceManager-Texte](https://github.com/theDeniZ/ServiceManager/blob/d014ade949b1b485699a7b024815d1d19df583a9/serviceitem.cpp)

Der Pi bezieht die mitgelieferte ServiceHistory-Referenz unabhängig von der SQLite-Datei ein. Sie enthält die aus 0.10.10 bekannten Plan-Zuordnungen und die weiteren dokumentierten ServiceHistory-Codes. Die Referenzdatenbank kennzeichnet den Ursprung als extern. Mehrdeutige und unbekannte Werte lösen keine Fälligkeit aus. Gleichrangig widersprüchliche SQLite- und Basisreferenzen bleiben mehrdeutig. Eine fahrzeuggebundene Referenz hat Vorrang vor der allgemeinen Dokumentation.

Der Pi verwendet vorhandene Rohdaten, Durchführungsstatus und individuelle Intervalle. Historische Einträge werden erneut ausgewertet. Historische Importe behalten ihre Referenzen und lokalen Ergänzungen. Ein erneuter MGU-Scan ist unnötig.

## Migrationstest

Die Tests verwenden die vom Nutzer gelieferten fünf anonymisierten Datensätze. Für den Test sind deren Positionen als durchgeführt markiert. Eine zusätzliche unvollständige Position darf keinen Termin ändern.

| Wartung | 0.10.10 | 0.10.13 |
| --- | --- | --- |
| Motoröl | 31.10.2027 / 103.747 km | 31.10.2027 / 103.747 km |
| Mikrofilter | 31.07.2028 / 117.921 km | 31.07.2028 / 117.921 km |
| Bremsflüssigkeit | 31.07.2028 | 31.07.2028 |
| Fahrzeug-Check | 31.07.2030 / 147.921 km | 31.07.2030 / 147.921 km |
| Motorluftfilter | Ableitung aus dem BMW-Ölzyklus möglich | Dokumentiert, 31.10.2030 / 155.747 km |
| Kraftstofffilter | Ableitung aus dem BMW-Ölzyklus möglich | Dokumentiert, 12.04.2030 / 139.780 km |

Die vier bisherigen Termine wurden zusätzlich mit dem tatsächlich gestarteten 0.10.10-Server verglichen. Die korrigierte Version liefert die erwarteten Ergebnisse bei fehlender, leerer und beschädigter Datenbank sowie nicht erreichbarer MGU. Die beschädigte Datei bleibt erhalten. Das Ölintervall bleibt bei 8.000 km und zwölf Monaten. Regressionstests decken außerdem importierte Daten, Mehrdeutigkeit, Getriebeöl, Kühlflüssigkeit, die HTTP-Datenkette und den Pi-Updater ab. Der Test lief gegen lokale Prozesse. Die Installation am Nutzer-Pi wurde nicht ausgeführt.
