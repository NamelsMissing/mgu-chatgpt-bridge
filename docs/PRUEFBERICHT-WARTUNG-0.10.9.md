# BMW AI 0.10.9 – vorhandene Servicehistorie auswerten

Die bisherige Berechnung erkannte BMW-Arbeiten vor allem über bekannte Scope-Namen. Ein zentraler Abgleich verarbeitet jetzt bestätigte Scope-Codes, eindeutige Servicebezeichnungen, ausdrücklich abgeschlossene Arbeiten in lokalen Texten und zugeordnete Wartungsarten. Import, Historienzuordnung und Berechnung verwenden dieselben Regeln. Laufende, ausstehende und unvollständig ausgeführte Arbeiten werden bei der Berechnung übersprungen.

- Ein dokumentierter Motorluftfilter- oder Dieselfilterwechsel gibt Datum und, sofern vorhanden, Kilometerstand vor. Wenn ein dokumentierter Wechsel fehlt, verwendet der G21-Plan einen erkennbaren großen BMW-Service oder jeden zweiten regulären Ölservice in der verfügbaren BMW-Historie. Bei fehlendem bestätigtem Zyklusanker beginnt die Zählung mit dem ältesten sichtbaren BMW-Ölservice. Der Termin ist eine Schätzung und erzeugt keinen Durchführungsnachweis. Mehrfach gemeldete Besuche am selben Tag werden in diesem Zyklus einmal gezählt. Eigene Ölwechsel bleiben außerhalb des BMW-Zyklus.
- Bei Kühlflüssigkeit werden eindeutige Wechsel berücksichtigt. Nachfüllen und Füllstandskontrolle belegen keinen Wechsel. Bei vorhandener Erstzulassung kann der Pi nach 36 Monaten einen als Schätzung gekennzeichneten Vorsorgetermin vorschlagen.
- Die HU/AU-Ansicht bevorzugt ein vorhandenes BMW-CBS-Datum. Lokale Festtermine und der errechnete Wartungsplan sind zusätzlich in den Details sichtbar. Ein dokumentierter HU-Termin führt zum 24-Monats-Intervall. Ohne HU-Nachweis liefert die Erstzulassung den ersten 36-Monats-Termin.
- Für „Code 11“ und „Code 12“ liefern die verfügbaren Referenzen keine verifizierte Zuordnung. Sie bleiben in der Historie erhalten und erzeugen keine Fälligkeit.
- Der Pi berechnet diese Ergebnisse mit dem vorhandenen Datenbestand. Weder Fahrzeugscan noch Neuimport, Profiländerung oder MGU-Update sind erforderlich. Individuelle Intervalle wie 8.000 km und zwölf Monate für Öl bleiben bestehen.

## Prüfung

Die Repository-Tests prüfen bekannte BMW-Filterarbeiten, einen doppelten BMW-Ölservice im Zyklus, zusätzliche eigene Ölwechsel, unbekannte Codes, nicht ausgeführte Arbeiten, textbasierte Kühlmittel- und HU-Erfassung, CBS und Fälligkeiten ohne Kilometerstand. Der Migrationstest verwendet einen gespeicherten Bestand und startet den Pi-Serverprozess ohne erreichbare MGU neu. Die Prüfungen verwenden lokale Testdaten. Die Historie des konkreten Fahrzeugs lag nicht vor.
