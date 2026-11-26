# BMW AI 0.10.12 – Getriebeöl im Wartungsplan

Die bestehenden G21-Diesel- und übernommenen G21-Wartungspläne ergänzen Automatikgetriebeöl und Hinterachsgetriebeöl beim Start. Beide erhalten als individuell gewünschte Vorsorge 80.000 km oder 72 Monate. Vorhandene gleichartige, eindeutig benannte Positionen behalten ihre Intervalle. Kühlflüssigkeit behält ihren Standard von 36 Monaten und vorhandene individuelle Änderungen. Die Planwerte sind keine BMW-Werksintervalle.

Unter **Fahrzeug → Wartungsplan bearbeiten** lässt sich die Ausstattung für den Plan einstellen. Ein Verteilergetriebeöl-Wechsel wird zur Aufnahme angeboten, sobald das Verteilergetriebe bestätigt und die Einstellung gespeichert wurde. Sein Intervall wird individuell eingetragen. Deaktivierte Positionen werden aus der Fälligkeitsliste ausgeblendet und bleiben im Datenbestand. Die Ausstattung wird nicht aus der FIN abgeleitet.

| Code | Beleg im Referenzbestand | Konsequenz |
| --- | --- | --- |
| 18 / 0x12 | `IDScopeCBS`: `KUEHLFLUESSIGKEIT` | Gilt für den CBS-Namensraum. |
| 35 / 0x23 | `IDScopeCBS`: `GETRIEBEOEL_HAUPTGETRIEBE`. KOMBI-CBS führt Getriebeöl, KOMB_G11 zusätzlich eine ausdrücklich als Automatik bezeichnete Variante. | Der bestehende BMW-CBS-Status für Hauptgetriebeöl kann in der Darstellung der Automatikposition zugeordnet werden, wenn das Automatikgetriebe im Plan aktiv ist. Der Status belegt keine durchgeführte Wartung. |
| 9 / 0x09 | `IDScopeCBS`: `GETRIEBEOEL`. In den bereitgestellten ServiceHistory-Referenzen fehlt eine Belegstelle für QMV-H-Öl. | QMV-H bleibt eine separate Ölart. Der Code wird keinem Hinterachsgetriebe zugeordnet. |

Im ServiceHistory-Namensraum bleibt `serviceText` ein UInt8 ohne dokumentierte Bedeutungstabelle. Die drei Werte bleiben dort offen. Eindeutig benannte und als durchgeführt dokumentierte BMW-Arbeiten sowie eigene geeignete Einträge liefern das Datum und den Kilometerstand der letzten Wartung. Bestätigte ServiceHistory-Referenzen können weiterhin fahrzeuggebunden importiert werden. Ohne Nachweis bleibt der letzte Ölwechsel unbekannt. Die vorhandene Schätzung für Kühlflüssigkeit ab Erstzulassung bleibt als solche gekennzeichnet. BMW-CBS und Pflegeplan bleiben getrennt sichtbar.

Tests prüfen Migration und Neustart, Erhalt eines individuell abweichenden ATF-Intervalls, bestätigte Wechsel, ignorierte mehrdeutige ServiceHistory-Codes und Aktivierung des Verteilergetriebes. Ein MGU-App- oder Agent-Update ist nicht erforderlich. Fahrzeugausstattung und tatsächliche Fälligkeiten wurden nicht am Ziel-G21 geprüft.
