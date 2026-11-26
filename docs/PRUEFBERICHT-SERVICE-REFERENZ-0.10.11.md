# BMW AI 0.10.11 – Servicecode-Referenz

Versionen sind Pi 0.10.11 und Vehicle Data 0.2.9. Companion Agent 0.2.12 übernimmt das bisherige Snapshot-Format. Die Kilometerstandsabfrage und das SOME/IP-Pflichtmanifest wurden nicht geändert.

## Auswertung

Der bereitgestellte Zielkatalog 0.1.0 führt über ServiceHistory.readServiceHistory, ArrayOfDataSets und ArrayOfServiceEntries zum Feld ServiceEntriesStruct.serviceText vom Typ UInt8. Dieser Typ enthält keine Bedeutungstabelle. CorrectionNumberType ist ein UInt8-Zähler. ServiceStatusEnum und StatusOperationType sind dagegen vollständig als Enums definiert. Die CBS-Felder von ConditionBasedServicesLegacy, KombiInterface_2 und die zugehörigen Wartungs-, Farb-, Status- und Untersuchungs-Enums wurden separat ausgewertet. Der OAP-SDK-Bestand und der MotorScope-Parser liefern keine ServiceText-Enum. Eine separate Datei ServiceHistory-SOMEIP-Referenz.json lag im Workspace nicht vor.

Die PRGs KOMBSP18, KOMBSP21 und KOMB_G11 liefern nummerierte CBS-Kennungen, Einheiten und Zustände. Die übrigen bereitgestellten PRGs BDC, BDC_G05 und D83BX7C0 liefern für ServiceHistory 11/12 keine belegte Bezeichnung. Die beiden Extraktoren erzeugen ausschließlich passende Tabellenzeilen und Metadaten, ohne den BMW-Katalog oder PRGs zu veröffentlichen.

| Startbestand | Anzahl |
| --- | ---: |
| SOME/IP-Definitionen aus neun Enum-Typen | 53 |
| KOMBI-PRG-Definitionen einschließlich Zuständen und Einheiten | 472 |
| Referenzzeilen insgesamt | 525 |
| Eindeutig bestätigte Code-/Kontextkombinationen | 457 |
| Als reserviert oder ungültig markierte Zeilen | 64 |
| Mehrdeutige Code-/Kontextkombinationen | 1 |
| Vorab beobachtete unbekannte Codes | 0 |

Die Zahl unbekannter Codes wächst aus dem jeweiligen lokalen Snapshot. Im Testbestand wurden 11 und 12 als zwei unbekannte ServiceHistory-Codes erfasst. Dezimal 11/12 sind 0x0B/0x0C. Hexadezimal 0x11/0x12 sind dezimal 17/18. Die bekannten CBS-Zuordnungen für 17 oder 18 werden nicht in ServiceHistory übertragen. Frühere aus CBS abgeleitete Beschriftungen für numerische ServiceHistory-Positionen sind deshalb ohne passende ServiceHistory-Referenz nicht mehr als Ausführungsnachweis wirksam. Eigene ausdrücklich dokumentierte Arbeiten, BMW-CBS und individuelle Intervalle bleiben unabhängig davon auswertbar.

## Betrieb und Import

Die Datenbank `service-reference.sqlite` liegt lokal im Pi-Datenverzeichnis. **System → BMW-Servicecode-Referenz** bietet Suche, Statusfilter, Import und den privaten Export unbekannter oder mehrdeutiger Beobachtungen. Ein Beobachtungszähler zählt erfolgreiche, voneinander unterscheidbare ServiceHistory-Lesestände je Code und Fahrzeugkontext. Bei Altbeständen ohne Lesezeit werden unterschiedliche gespeicherte Serviceeinträge gezählt. Der Fahrzeugkontext ist ein Hash der gekoppelten MGU-Adresse, keine FIN. Bereits vorhandene BMW-Rohdaten werden bei Installation und neuem Import berücksichtigt.

Der JSON-Import erwartet `schema: 1` und ein Array `rows`. Je Zeile sind `namespace`, `code`, `original`, `interface`, `source`, `version` und `verification` erforderlich. Für `verified` sind zusätzlich `de` und eine als `description` dokumentierte Belegstelle erforderlich. Optional sind `en`, `category`, `work`, `vehicle`, `variant`, `compatibility` und `table`. `work` kann einer vorhandenen Planposition entsprechen, etwa `airFilter` oder `fuelFilter`. Fahrzeugabhängige ServiceHistory-Nachweise können über den im Unbekannt-Export gelieferten `vehicle`-Schlüssel begrenzt werden. Varianten werden nur bei ausdrücklich bekanntem Auflösungskontext verwendet. Ein Import ist eine lokale Referenzfreigabe durch den Betreiber. Der Pi validiert Format, Belegfelder und Konflikte, die fachliche Echtheit der angegebenen Quelle bleibt zu prüfen. Ungeprüfte Einträge beeinflussen die Wartungsberechnung nicht. Gleichrangig widersprüchliche Referenzen bleiben mehrdeutig.

### Fehlende Referenz für 11 und 12

Benötigt wird eine Zuordnung **innerhalb ServiceHistory**, etwa die Original-HMI-Tabelle, die die Rohwerte 0x0B und 0x0C zu Übersetzungsschlüsseln auflöst, samt zugehöriger deutscher Ressource. Alternativ genügt ein anonymisierter Live-Mitschnitt, der für denselben Datensatz und dieselbe Position den Rohcode und den tatsächlich angezeigten iDrive-Text belegt. Die generierte Proxydatei ist für die Überprüfung des Datentyps hilfreich und enthält voraussichtlich ebenfalls nur UInt8.

Lesende Suche auf der MGU nach dem installierten Proxy und nach relevanten App-Ressourcen:

```sh
find /var/opt/public/oap -type f -name 'com_harman_infotainment_systemfunctions_servicehistory_ServiceHistory.json' -print
find /usr/lib/oap-mainapp /var/opt/public/oap -iname '*servicehistory*' -print
```

## Prüfung

Extraktion wurde mit dem gelieferten Katalog und den PRGs reproduziert. Die automatisierten Tests prüfen Namensraumgrenzen, Hex/Dezimal, Beobachtungszähler, Mehrdeutigkeit, fahrzeug- und variantengebundene Einträge, Importkonflikte und die Neuberechnung historischer Fälligkeiten ohne Fahrzeugverbindung. Der Store-Build und die Node-8.7-Syntaxprüfung sind bestanden. Die BMW-Generatorprüfung am Zielgerät bleibt ohne dessen AppManagement.js offen. Keine Installation oder Live-Messung am Fahrzeug.
