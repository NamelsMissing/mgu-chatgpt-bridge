# BMW AI Pi 0.5.0 – Diagnosemodus und Claude-Anbindung (MCP)

Der Pi-Server (`pi-source/`) hat einen MCP-Endpunkt, über den Claude Diagnoseaufträge **vorschlagen** kann. Ausgeführt wird nur, was du auf der Website unter „Freigaben“ einzeln bestätigst.

**Stand:** lokal gegen eine simulierte MGU und ein simuliertes Tailscale-CLI getestet (`pi-source/tests/test-claude-mcp.js`). Nicht mit einem echten Claude-Konto, nicht mit echtem Tailscale Funnel und nicht am Fahrzeug getestet.

## Was sich ändert

- **Diagnosemodus** (Website → Diagnose): schaltet den MCP-Zugang für 30 Minuten, 2 oder 8 Stunden ein. Danach, nach „Beenden“ und nach jedem Neustart des Servers ist er aus; dann antworten `/mcp`, `/oauth/*` und `/.well-known/*` mit 503.
- **Freigaben bleiben auf der Website.** Der MCP-Zugang hat kein Werkzeug zum Freigeben, keine Shell und keine Fahrzeugfunktionen. Claude sieht nur Aufträge, die es selbst vorgeschlagen hat. Offene Vorschläge verfallen nach fünf Minuten und mit dem Ende des Diagnosemodus.
- **Website bleibt privat.** Anfragen, die über Tailscale Funnel kommen (Kopfzeile `Tailscale-Funnel-Request`), erreichen nur die MCP-/OAuth-Routen. Website, Login und API antworten ihnen mit 404.
- **Aufgeräumte Website:** sechs Reiter statt zehn (Chat, Freigaben, Diagnose, Konsole, Dateien, System). Alte Links wie `#console` oder `/pair` funktionieren weiter.

## Werkzeuge für Claude

| Werkzeug | Wirkung |
|---|---|
| `get_bridge_status` | Zustand der Bridge, kein Kontakt zum Fahrzeug |
| `request_vehicle_status`, `request_diagnostic`, `request_file_list`, `request_file_download`, `request_console_command` | legt einen Auftrag an, der auf deine Freigabe wartet |
| `get_job_result` | Status/Ergebnis eines eigenen Auftrags, wartet auf Wunsch bis zu 30 s auf die Freigabe |
| `list_jobs` | die letzten 20 eigenen Aufträge |

Mit der Freigabe eines Claude-Auftrags geht das Ergebnis an Claude (Anthropic). Freigegebene Textdateien bis 128 KiB werden als Text mitgegeben.

## Einrichtung

### A) Claude-App / claude.ai (braucht Tailscale Funnel)

Claude verbindet sich von Anthropics Servern aus und nur über HTTPS auf Port 443. Der Pi muss dafür öffentlich erreichbar sein; im Tailnet allein geht es nicht.

1. Funnel für das Tailnet erlauben (Tailscale-Adminkonsole, einmalig) und den Dienstbenutzer zum Operator machen, damit der Server Funnel schalten darf:
   ```sh
   sudo tailscale set --operator=<Benutzer des BMW-AI-Dienstes>
   ```
2. Website → Diagnose → „Port 443 automatisch mit dem Diagnosemodus öffnen“ einschalten. Der Server führt dann beim Start des Diagnosemodus `tailscale funnel --bg --https=443 http://127.0.0.1:<PORT>` aus und beim Ende `tailscale serve --bg --https=443 http://127.0.0.1:<PORT>` (wieder nur Tailnet). Fehler stehen direkt unter dem Schalter.
   Ohne den Schalter ändert der Server nichts an Tailscale; dann die beiden Befehle von Hand ausführen.
3. Diagnosemodus starten, die angezeigte Adresse (`https://bmw-ai-pi.<tailnet>.ts.net/mcp`) kopieren.
4. In Claude einen benutzerdefinierten Connector mit dieser Adresse hinzufügen. Anmeldung: OAuth. Der Server unterstützt nur die automatische Client-Registrierung (DCR), keinen Client-ID-Metadaten-Abruf.
5. Claude öffnet eine Seite mit einem sechsstelligen Code. Auf der Website unter Diagnose → „Verbindungsanfragen“ die Anfrage mit demselben Code erlauben. Die öffentliche Seite fragt nie ein Passwort ab.

Die Verbindung bleibt bestehen (Refresh-Token 30 Tage, rotierend), bis du sie unter „Verbundene Clients“ widerrufst. Nutzbar ist sie nur, solange der Diagnosemodus läuft.

### B) Claude Code auf einem Gerät im Tailnet (ohne Funnel)

```sh
claude mcp add --transport http bmw-ai https://bmw-ai-pi.<tailnet>.ts.net/mcp
```

Anmeldung und Freigaben laufen genauso wie oben.

## Einstellungen (`.env`, alle optional)

| Variable | Bedeutung |
|---|---|
| `MCP_PUBLIC_URL` | Öffentliche Adresse fest vorgeben (`https://…`, ohne Pfad). Sonst aus den Proxy-Kopfzeilen. |
| `MCP_EXTRA_REDIRECT_URIS` | Weitere erlaubte OAuth-Rückleitungen, kommagetrennt. Standard: nur Claudes Callback und Loopback. |
| `TAILSCALE_BIN` | Pfad zum Tailscale-CLI (Standard `tailscale`). |

## Grenzen

- Solange Funnel offen ist, kann jeder aus dem Internet die OAuth-Seiten aufrufen und Verbindungsanfragen erzeugen. Sie sind auf fünf gleichzeitig und 20 pro Minute begrenzt und ohne deine Bestätigung wirkungslos; deshalb den Code vergleichen.
- Der Funnel-Schutz der Website hängt an der Kopfzeile, die Tailscale setzt. Der Server muss weiter nur auf 127.0.0.1 lauschen.
- Über MCP gibt es dieselben Lesefunktionen wie auf der Website: keine Steuergerätewerte (DDE/BDC), keine Fahrzeugfunktionen.
