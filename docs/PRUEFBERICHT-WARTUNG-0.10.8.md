# BMW AI 0.10.8 – Wartungsplan und Servicehistorie

Die Standardwartungen wurden bislang ausschließlich beim manuellen Speichern des G21-Diesel-Profils angelegt. Der Pi ergänzt die fehlenden Wartungsarten nun einmalig beim Start im vorhandenen Altbestand mit Öl-Wartungsart ohne gesetztes Profil sowie bei einem bereits gewählten G21-Diesel-Profil. Der Altbestand ohne Profil erscheint als **Übernommener Wartungsplan**. Dieser Name behauptet keine Fahrzeugidentifikation. Explizite andere Profile bleiben erhalten. Bei einer anderen MGU-Adresse verwendet der Pi einen separaten Wartungsplan und wiederherstellbare Historien. Eine Änderung der MGU-Adresse identifiziert das Fahrzeug nicht physisch.

Vorhandene Kategorien werden anhand fester Bezeichnungsvarianten erkannt. Individuelle Namen, Einträge, Fristen und Intervalle bleiben erhalten, einschließlich 8.000 km und zwölf Monaten für Öl. Kühlflüssigkeit und weitere bekannte Wartungsarten erscheinen auch ohne letzten Wechsel. Die Anzeige bewertet BMW CBS und lokale Fälligkeiten getrennt und zählt Fälligkeiten pro Kategorie. Zeit- und Kilometergrenzen werden für den nächsten Service getrennt verglichen.

BMW-Importe werden anhand einer dauerhaften Referenz gruppiert. Sie berücksichtigt Datum, Kilometerstand, Händler, Korrekturstand und dokumentierten Serviceumfang. Der Pi verknüpft Altimporte nur bei erkennbarer Importherkunft und eindeutiger Übereinstimmung. Lokale Kosten, Notizen und Änderungen bleiben im gemeinsamen Eintrag sichtbar. Historische Datensätze werden dabei nicht gelöscht. Altimporte mit fehlender Herkunft oder mehrdeutiger Zuordnung bleiben als getrennte Einträge sichtbar.

## Bestandene Prüfungen

- Start mit einem 0.10.7-Altbestand mit ausschließlich Öl und ohne Profil. Acht Wartungsarten werden angelegt, Öl bleibt bei 8.000 km und zwölf Monaten.
- Echter Neustart des lokalen Pi-Serverprozesses, während die MGU nicht erreichbar ist. Wartungsarten, Änderungen und Importreferenzen bleiben erhalten. Ein Wechsel des gespeicherten MGU-Ziels wählt einen eigenen Wartungsbestand.
- Abweichender Eintragsname „Pollenfilter“ mit individuellem Intervall, vorhandenes Profil „Individuell“, Fälligkeiten aus dokumentiertem Bremsflüssigkeits- und Kühlmittelwechsel, unbekannter Wechsel und erster Termin anhand der Erstzulassung.
- Doppelter BMW-Snapshot, bearbeiteter Altimport mit Kosten und Notizen, neue eindeutige Importreferenz, abgelehnter mehrdeutiger Import und eigenständige Wartung am gleichen Datum und Kilometerstand.
- Beide npm-Testsuiten sowie die ergänzenden Referenz- und Manifesttests. Desktop-, iPhone- und iPad-Ansicht wurden in Chromium mit lokalem Pi-Server geprüft.

Das signierte Pi-Update 0.10.8 wird über den bestehenden Stable-Kanal verteilt. Vehicle Data und Companion Agent benötigen für diese Änderung kein Update. Eine Installation auf dem Ziel-Pi oder ein Test am echten Fahrzeug fand bei dieser Prüfung nicht statt.
