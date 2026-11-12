# BMW AI Pi – sichere automatische Updates

Die Raspberry-Pi-Software wird über einen **separaten Release-Kanal** im bestehenden öffentlichen MGU-Repository aktualisiert:

- Quellcode: `pi-source/`
- GitHub Actions: `.github/workflows/bmw-ai-pi-release.yml`
- Veröffentlichungen: `pi-updates/stable.json` und `pi-updates/BMW_AI_Pi_Update_vX.Y.Z.zip`

**Keine** ChatGPT-Token, MGU-Geräteschlüssel, Server-Passwörter oder privaten Signierschlüssel committen.

## Einmalige Ersteinrichtung (v0.4.0)

1. Der Raspberry Pi muss das Bootstrap-Update v0.4.0 besitzen. Das von der Webseite bediente Update-System akzeptiert ausschließlich mit dem vorher eingerichteten öffentlichen Schlüssel signierte Pakete.
2. Im GitHub-Repository unter **Settings → Secrets and variables → Actions → New repository secret** einen Secret `BMW_AI_UPDATE_SIGNING_KEY_B64` anlegen. Wert ist **Base64 des zuvor für v0.4.0 generierten privaten Ed25519-Schlüssels**, ohne Zeilenumbruch. Niemals in Code, Commit, Chat oder Issue kopieren.
3. Das vom Projekt bereitgestellte einmalige ZIP `BMW_AI_GitHub_Quellcode_Ersteinrichtung_v0.4.0.zip` über GitHub **Add file → Upload files** in den Ordner `pi-source/` hochladen. Die Datei muss exakt unter `pi-source/BMW_AI_GitHub_Quellcode_Ersteinrichtung_v0.4.0.zip` landen. Sie enthält nur den publishbaren Pi-Quellcode, keine Zugangsdaten. Die Pipeline verifiziert ihren SHA-256-Hash gegen den fest hinterlegten Wert, entpackt fünf geprüfte Quellcodedateien, entfernt das Bootstrap-ZIP aus dem Release-Commit und veröffentlicht ein signiertes 0.4.0-Paket.
4. Auf **Actions → Publish signed BMW AI Pi update** prüfen, ob der Workflow erfolgreich ist. Bei einem Fehler wegen GitHub-Token-Schreibrechten unter **Settings → Actions → General → Workflow permissions** ggf. `Read and write permissions` freigeben.
5. Erst danach auf der privaten BMW-AI-Webseite → **Updates** die automatischen GitHub-Updates aktivieren. Auf dem Pi läuft der Check alle etwa 30 Minuten. Bereits installierte Version 0.4.0 wird nicht erneut installiert.

## Folgeupdates

Die fünf Dateien im Ordner `pi-source/` und `pi-source/VERSION` werden per Commit aktualisiert. GitHub Actions prüft die JavaScript-Syntax, Signierberechtigung sowie Versionsübereinstimmung und veröffentlicht eine neue signierte ZIP unter `pi-updates/`. Auf dem Raspberry Pi prüft der Root-Updater Signatur, SHA-256-Werte und neue Versionsnummer, erstellt ein Backup und führt einen Health-Test aus; bei Startfehler erfolgt ein Rollback.

**Wichtig:** GitHub kann nicht von sich aus in deinen privaten Raspberry Pi hinein zugreifen; der Pi selbst stellt ausgehend eine HTTPS-Verbindung zu GitHub her, ohne Router-Portfreigabe. Automatische Updates installieren ausführbaren Servercode; schütze deshalb das private Signier-Secret und den Main-Branch besonders gut.
