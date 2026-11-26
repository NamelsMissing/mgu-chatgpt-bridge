# Diagnoseberichte vom Pi auf GitHub

Ab Pi-Version 0.10.7 kann der BMW AI Assistant einen kompakten Diagnosebericht in einem privaten GitHub-Repository aktualisieren. Die Automatik ist bei der Installation ausgeschaltet.

## Einrichtung

1. In GitHub unter **Settings → Developer settings → Personal access tokens → Fine-grained tokens** ein Token mit einer passenden Laufzeit erstellen. Als **Resource owner** das Konto des Ziel-Repositorys auswählen, das Token auf **Only select repositories** beschränken und das private Diagnose-Repository auswählen. Unter **Repository permissions** für **Contents** den Wert **Read and write** wählen. Die Standardberechtigung für **Metadata** genügt. Das Repository braucht einen initialen Commit und die Möglichkeit, die Zieldatei auf dem Standardbranch zu aktualisieren.
2. Auf der privaten BMW-AI-Website **System → Diagnoseberichte auf GitHub** öffnen. `Konto/Repository` und das Token eingeben, **Automatische Übertragung freigeben** auswählen und speichern. Das Token bleibt in einer eigenen Datei mit Modus `0600` im Datenverzeichnis des Pi.
3. Die Seite zeigt den Zeitpunkt des letzten bestätigten Berichts und eventuelle GitHub-Fehler. Zum Abschalten die Freigabe abwählen und speichern.

## Inhalt und Zeitpunkt

Der Bericht enthält Softwareversionen, Verbindungsstatus, HTTP-Ergebnisse bekannter Diagnose-Endpunkte, Datenquellen, Abfrage- und Decoderstatus sowie Zeitstempel des letzten erfolgreichen Empfangs. Die Feldnamen und Statuswerte stammen aus einer festen Liste. Freitext, Fahrzeugmesswerte, FIN, Rohdaten, Sensor-IDs, Fahrzeugdateien und Zugangsdaten sind ausgeschlossen.

Der Pi prüft vor jeder Übertragung die private Sichtbarkeit des Ziel-Repositorys. Er nimmt nach dem ersten Fehler höchstens alle fünf Minuten den neuesten geänderten Zustand auf, einschließlich einer anschließenden Wiederherstellung. Gleiche Zustände erzeugen keine neuen Commits. Mehrere schnelle Zustandswechsel können zu einem Bericht zusammenfallen. GitHub speichert `diagnostics/latest.json` auf dem Standardbranch. Frühere Berichte bleiben im Commit-Verlauf verfügbar.

Die Datenübertragung läuft vom Pi zu GitHub über HTTPS. Wird der Pi gestoppt oder hat er keinen Internetzugang, kann er keinen Bericht senden. Verbindungsfehler werden lokal angezeigt und beim nächsten zulässigen Durchlauf erneut versucht.
