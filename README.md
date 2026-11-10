# MGU Analysis Bridge 0.1.0

Eine private Verbindung zwischen ChatGPT und deinem MGU: ChatGPT schlägt einen konkreten Analyseauftrag vor, du bestätigst ihn im persönlichen Portal, der Dienst im Auto führt ihn einmalig aus und liefert das Ergebnis zurück.

**Status:** lokal implementiert und getestet, ID7-App gebaut. Nicht am Fahrzeug getestet, nicht auf einem Internetserver bereitgestellt und noch nicht mit deinem ChatGPT-Konto verbunden. Dafür sind ein erreichbarer HTTPS-Server und die einmalige Einrichtung erforderlich. Diese Version ist ein privater Prototyp, keine veröffentlichte ChatGPT-Verzeichniserweiterung.

## Enthalten

- ID7-App mit Verbindungsstatus, QR-Link zum Portal und Enable/Stop-Tasten.
- systemd-Hintergrunddienst, der beim MGU-Start unabhängig vom App-Menü startet.
- Privater Vermittlungsserver mit Freigabeportal und MCP-Endpunkt.
- OAuth-Anmeldung mit PKCE und getrennten Rechten für ChatGPT und Eigentümer.
- Einmalige Gerätekopplung, Widerruf, Ablaufzeiten, Ergebniswarteschlange und Schutz vor Wiederholung nach einem Absturz.
- Docker-/Caddy-Konfiguration für einen eigenen HTTPS-Server.

## Was Version 0.1 kann

| Funktion | Umsetzung |
|---|---|
| System | `uname -a`, `uptime` |
| Prozesse | `ps` |
| Netzwerk | `ip -4 addr`, `ip -4 route` |
| Audio | `aplay -l`, `aplay -L` |
| Dienste | `systemctl --failed --no-pager --plain` |
| Dateiabruf | Exakter Pfad, Offset und Länge, maximal 128 KiB pro freigegebenem Auftrag, Base64 und SHA-256 |
| Freie Shell-Befehle | Implementiert; zusätzlich lokal `allowShell: true` erforderlich, standardmäßig aus |

Jeder Auftrag benötigt deine eigene Freigabe im Portal, einschließlich der Dateiübertragung. Der ChatGPT-Zugang kann diese Freigabe nicht erteilen. Ein bestätigter Auftrag gilt höchstens 90 Sekunden; ein noch nicht bestätigter Auftrag verfällt nach fünf Minuten. Es gibt kein automatisches Nachholen alter Befehle. Eine laufende Ausführung lässt sich durch Widerruf am Server nicht zuverlässig zurückholen; Stop/Pause im Auto beendet den laufenden Befehlsprozess und sperrt weitere Aufträge. Bereits übermittelte Daten werden dadurch nicht zurückgerufen.

Dateien kommen als Base64-Chunks zurück. Größere Dateien erfordern mehrere separat freigegebene Chunks. Es gibt noch keinen automatischen Komplettdownload großer Archive. Fehlerhafte Befehle werden mit Rückgabecode/Fehler ausgegeben. Ein technisch übermitteltes Ergebnis ist keine Bestätigung, dass eine Fahrzeugfunktion physisch reagiert hat.

## 1. Vermittlungsserver bereitstellen

Benötigt werden ein eigener Linux-Server mit Docker Compose und eine Domain, deren DNS auf ihn zeigt. TCP 80 und 443 müssen erreichbar sein. Keine Fahrzeug-IP oder SSH-Schnittstelle wird veröffentlicht.

Im entpackten Projektordner:

```sh
cp .env.example .env
# In .env BRIDGE_DOMAIN auf deine echte Domain ändern.
docker compose up -d --build
docker compose exec broker node broker/admin.js owner-key
```

Den ausgegebenen **Eigentümerschlüssel privat halten und niemals ChatGPT mitteilen**. Er dient nur zur Anmeldung im Portal und zur bewussten Verbindung des MCP-Clients. Das Portal liegt unter `https://DEINE-DOMAIN/owner`. Die Seite hält den Schlüssel nur im Arbeitsspeicher bis zum Abmelden/Schließen. Server-Schlüssel und Ergebnisse liegen im privaten Docker-Volume. Das Volume sichern; es enthält Zugangsdaten und Diagnosedaten. Ein Prozess/Replica pro Volume; die JSON-Zustandsdatei ist nicht für mehrere gleichzeitige Serverinstanzen ausgelegt.

Nur für einen Test am eigenen Rechner, ohne Internetfreigabe:

```sh
node broker/server.js
node broker/admin.js owner-key
```

Dann `http://127.0.0.1:8787/owner` öffnen. Das Auto erreicht diesen Rechner nicht unter dessen Loopback-Adresse; der lokale Test ersetzt keinen HTTPS-Server.

## 2. MGU installieren

Im MGU Store unter den Quellen dieses Repository hinzufügen:

```text
https://github.com/NamelsMissing/mgu-chatgpt-bridge
```

Als Branch `main` wählen und die Quelle aktualisieren. Danach **MGU Analysis Bridge** installieren; der Eintrag benötigt **MGU Analysis Bridge Service**, den der Katalog als Abhängigkeit führt. Falls der Store die Abhängigkeit nicht automatisch auswählt, zuerst den Service und danach die App installieren. App und Service starten ohne Kopplung im inaktiven Zustand. Für die spätere Verbindung ist weiterhin der eigene HTTPS-Vermittlungsserver erforderlich.

Das fertige App-Paket ist `dist/mgu_chatgpt_bridge@0.1.0.mgu`; für den Store ist zusätzlich das npm-Paket `.tgz` vorhanden. Über deinen vorhandenen MGU-Installer installieren. Der Begleitdienst kann aus dem entpackten Projekt oder dem Service-Archiv installiert werden:

```sh
# Auf dem MGU, im übertragenen/entpackten Projektordner:
sh tools/install-agent.sh install
```

Der manuelle Installer benötigt Root, `node` und `systemctl`. Er schreibt ausschließlich seine eigenen Dateien unter `/var/opt/mgu-chatgpt-bridge` und die zugehörige systemd-Unit. Einstellungen bleiben bei einer erneuten Installation erhalten. Danach ist der Dienst aktiv, führt ohne Kopplung aber keine Aufträge aus. Bei Installation über den Store übernimmt dessen Installer die Dienstdateien und Updates.

**Internet:** Die OAP-App enthält `mguInternet: true`. Der Root-Dienst erkennt die installierte App unter `/var/opt/public/oap/oap_<uid>`, prüft ihren Paketnamen und startet seine kurzlebigen Netzwerkanfragen mit genau dieser App-UID. Der MGU Store muss diese UID über `mgu-uplink` freigeben. DNS wird aus der Store-Lease übernommen. Root selbst erhält keine zusätzliche Internetfreigabe. Es werden keine eingehenden Fahrzeugports und keine neuen Firewallregeln geöffnet. Die Erkennung des App-Datenpfads, DNS, Zertifikate und die Route müssen am echten MGU überprüft werden. USB-/WLAN-Tethering des Stores muss bereits funktionieren.

## 3. Einmalig koppeln

1. Im Portal anmelden und unter „Neues Fahrzeug verbinden“ einen Code erzeugen.
2. Den dort angezeigten `node ... pair ...`-Befehl einmal über deine bestehende SSH-App am MGU ausführen. Der Code gilt fünf Minuten und ist nur einmal verwendbar.
3. Den angezeigten Dienst-Neustart ausführen.
4. In der ID7-App muss „BRIDGE ENABLED“ und ein aktueller Kontakt erscheinen. Im Portal wird das Fahrzeug angezeigt.
5. Im Portal „Verbindung selbst testen“ auswählen, den Systemtest lesen, das Kontrollfeld bestätigen und „Einmalig freigeben“ wählen.

Die einzige erforderliche manuelle SSH-Eingabe zur Verbindung ist damit die erste Kopplung/Installation. Danach werden freigegebene Aufträge über die Brücke ausgeführt.

## 4. Mit ChatGPT verbinden

Den eigenen MCP-Server in den ChatGPT-Web-Einstellungen für eigene Verbindungen hinzufügen:

- URL: `https://DEINE-DOMAIN/mcp`
- Authentifizierung: OAuth
- Bei der Weiterleitung auf **deine eigene Domain** mit dem privaten Eigentümerschlüssel bestätigen.

Der Server unterstützt OAuth-Erkennung, dynamische Clientregistrierung, Authorization Code mit PKCE/S256 und rotierende Refresh-Tokens. Der MCP-Zugang erlaubt nur das Vorschlagen von Aufträgen, Fahrzeugstatus und das Lesen von Ergebnissen. Keine Freigabefunktion wird als MCP-Tool angeboten. Der Server besitzt keinen OpenAI-API-Schlüssel und ruft selbst kein Modell auf. Die Verfügbarkeit eigener MCP-Verbindungen und der genauen Einrichtungsoberfläche hängt vom ChatGPT-Konto/Client ab; die echte ChatGPT-Verbindung und insbesondere iOS sind noch nicht verifiziert.

Möglicher Arbeitsablauf im Chat: „Frage nach meiner Freigabe die Audiogeräte meines BMW ab.“ ChatGPT ruft `request_audio` auf, du bestätigst im Portal und sagst im Chat Bescheid. ChatGPT liest anschließend `get_job_result`. Ein laufender Chat wird durch diese Version nicht automatisch mit neuen Meldungen aufgeweckt. Niemand kann aus diesem ZIP allein auf dein Auto zugreifen.

## 5. Einstellungen, Stop und Diagnose

Private Einstellungen: `/var/opt/mgu-chatgpt-bridge/config.json` (0600).

```json
{
  "enabled": true,
  "allowShell": false,
  "allowedReadRoots": ["/etc/cinemo", "/etc/oap", "/var/log", "/usr/lib"]
}
```

Das ist ein Ausschnitt: `server`, `deviceId`, `deviceKey`, `dataDir` und `leaseFile` der vorhandenen Datei beibehalten. `allowShell` nur bewusst am Auto aktivieren, wenn freie Befehle benötigt werden. Auch dann benötigt jeder exakte Shell-Befehl eine eigene Portal-Freigabe. Shell-Befehle laufen mit den Root-Rechten des Diagnoseagenten und sind **nicht** auf lesende Befehle beschränkt. Verzeichnisse mit Zugangsdaten und die Konfiguration der Brücke sind für den strukturierten Dateiabruf gesperrt; die Dateipfadfilter sind keine vollständige Geheimniserkennung. Ausgaben vor Übertragung prüfen, wenn dort Zugangsdaten stehen könnten.

```sh
systemctl status mgu-chatgpt-bridge.service --no-pager
journalctl -u mgu-chatgpt-bridge.service -n 60 --no-pager
```

Die App zeigt den letzten Verbindungsfehler, die Shell-Freigabe und die Zahl noch nicht übertragener Ergebnisse. „Stop / pause“ schreibt die Pause dauerhaft und beendet den laufenden Befehlsprozess. Die Bedienoberfläche darf für die Ausführung geschlossen sein. „Enable bridge“ aktiviert die Verbindung wieder. Der Dienst unterstützt den normalen MGU-Shutdown und hält das Auto nicht absichtlich wach.

Ergebnisse werden nach einer fehlgeschlagenen Übertragung lokal gespeichert und bei Wiederverbindung erneut übertragen, **ohne den Befehl erneut auszuführen**. Ein Absturz zwischen Befehlsstart und Ergebnisablage bleibt absichtlich „unknown“; ein neuer Versuch benötigt einen neuen Auftrag und eine neue Freigabe. Abgelaufene Aufträge werden verworfen. Zeit auf Server und Auto muss korrekt sein. Die Broker-Aufbewahrung beträgt 24 Stunden, abgeräumt bei der nächsten Anfrage. Bereits von ChatGPT gelesene Ergebnisse unterliegen zusätzlich der dortigen Chat-Aufbewahrung.

Zugriff im Portal für ein Fahrzeug widerrufen, um neue Abfragen/Ergebnisübertragungen zu sperren. Eine neue Kopplung erstellt eine neue Gerätekennung. Dienst entfernen:

```sh
sh tools/install-agent.sh uninstall
```

Konfiguration und Diagnosezustand bleiben zur bewussten manuellen Bereinigung erhalten; die App anschließend über den vorhandenen Installer entfernen.

## Entwickeln und prüfen

Broker und Tests benötigen Node 18 oder neuer. Die Fahrzeugdateien `agent/`, `shared/` und die App verwenden Node-8.7-kompatible Syntax. Es werden keine npm-Abhängigkeiten benötigt.

```sh
npm test
python3 kit/tools/build.py mgu_chatgpt_bridge
python3 tools/package.py
```

Der App-Build benötigt eine **lokal aus deinem eigenen Fahrzeug extrahierte** `oap-sdk` unter `oap-sdk/`. Die SDK-Quellen sind nicht im Quellpaket enthalten und sollen nicht veröffentlicht werden. Das fertige App-Paket enthält den zum Ausführen benötigten SDK-Wrapper. Vor einem öffentlichen Upload `dist/`, Zugangsdaten, `.env` und private Konfiguration ausschließen.

Die lokale Integration prüft unter anderem Anmeldung, separate Eigentümerrechte, Kopplung, tatsächliche Systemabfragen, exakte Dateiübertragung, Ablehnung/Verfall, Pause/Resume, Wiederholungsschutz, PKCE, einmalige OAuth-Codes, Refresh-Rotation und Widerruf. Der separate Fehlerpfadtest prüft Übertragungswiederholung, manipulierte Aufträge und Prozessgrenzen. MGU-Boot, Live-Tethering, RHMI-Bedienung, iOS und echter ChatGPT-OAuth-Login bleiben Fahrzeug-/Integrationstests.

## Herkunft

Kit/RHMI-Build und QR-Bibliothek basieren auf den bereits in `NamelsMissing/mgu-apps` vorhandenen Quellen, Stand 10.11.2026. Lizenzen siehe `THIRD_PARTY_KIT_LICENSE`, `THIRD_PARTY_QR_LICENSE` und `apps/mgu_chatgpt_bridge/QR-LICENSE`. BMW-SDK ausschließlich aus dem vom Nutzer bereitgestellten `x_call@4.25.3`-Paket.
