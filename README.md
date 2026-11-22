# BMW AI – Diagnose, Fahrzeugdaten und Claude für die BMW-MGU (iDrive 7)

Ein privates System für BMW mit iDrive 7 (Headunit MGU): Ein Raspberry Pi in deinem Tailscale-Netz zeigt eine Website mit Diagnose, Dateien, Kilometerstand und Serviceheft. Komponenten auf der MGU liefern dafür die Daten. Claude kann über einen zeitlich begrenzten Zugang Diagnoseaufträge vorschlagen.

**Grundsätze:** Ins Fahrzeug wird nichts geschrieben. Jeder Auftrag aus dem Chat oder von Claude braucht deine Freigabe auf der Website. Die Website ist nur in deinem Tailnet erreichbar.

**Stand:** Pi-Server, Agent und Apps sind lokal gegen simulierte Gegenstellen getestet. Die Werte der App Vehicle Data (Einheiten der Fahrzeugsignale) sind noch nicht am Auto abgeglichen.

## So hängt alles zusammen

```text
Fahrzeug ── SOME/IP und UDS (nur lesen) ──► Vehicle Data (App auf der MGU)
                                          │ bmw-vehicle-data.json (Anfragen zurück über bmw-vehicle-request.json)
                                          ▼
                    BMW AI Companion Agent (Dienst auf der MGU) ◄── BMW AI Bridge (App: Status, Kopplung)
                                          ▲
                                          │ Tailscale (privat)
                                          ▼
                    Raspberry Pi „bmw-ai-pi“: Website, Freigaben, Serviceheft, Bibliothek,
                    Hintergrundabfrage alle 2 Minuten ──► Benachrichtigungen (ntfy) aufs Handy
                                          ▲
                                          │ MCP über Tailscale Funnel, nur im Diagnosemodus
                                          ▼
                                       Claude
```

## Bestandteile

| Bestandteil | Läuft auf | Ordner | Aufgabe |
|---|---|---|---|
| **BMW AI Bridge** (App) | MGU | `apps/mgu_chatgpt_bridge` | Tailscale-Anmeldung und Kopplung mit dem Pi per QR-Code, Verbindungsstatus |
| **BMW AI Companion Agent** (Hintergrunddienst) | MGU | `native/mgu-ai-agent` | Führt freigegebene Leseaufträge aus (Diagnose, Dateien, Lesebefehle) und gibt die Fahrzeugdaten an den Pi weiter |
| **Vehicle Data** (App, startet mit dem Auto) | MGU | `apps/vehicle_data` | Liest Kilometerstand, Servicebedarf, Servicehistorie, Check-Control-Meldungen, Reifendruck, Fehlerspeicher und DPF-Werte aus dem Fahrzeug, [Details](apps/vehicle_data/README.md) |
| **Pi-Server** | Raspberry Pi | `pi-source/` | Website und API, Claude-Zugang (MCP), signierte Updates (`pi-updates/`) |
| Älterer ChatGPT-Vermittlungsserver | eigener Server | `broker/`, `agent/`, `native/chatgpt-bridge` | Erste Version mit eigenem HTTPS-Server, [Anleitung](docs/CHATGPT-BROKER.md) |

## Die Website

| Reiter | Inhalt |
|---|---|
| Chat | Fragen zum Fahrzeug und zu Diagnoseergebnissen, Import und Export von Chats |
| Freigaben | Aufträge aus dem Chat und von Claude einzeln bestätigen oder ablehnen, mit Verlauf |
| Fahrzeug | Kilometerstand mit Verlauf, Fälligkeiten (Öl standardmäßig 12 Monate oder 8.000 km, einstellbar), Serviceheft, Servicebedarf und Servicehistorie laut Fahrzeug, Reifendruck mit 7-Tage-Änderung, Dieselpartikelfilter mit Regenerationen |
| Fehler | Aktive Check-Control-Meldungen mit Fahrzeugtext und Verlauf, Fehlerspeicher aller Steuergeräte (Codes, Status, neu seit dem letzten Auslesen) |
| Diagnose | Diagnosemodus für Claude, MGU-Status, Systemdiagnosen, Berichte |
| Konsole | Einzelne Lesebefehle auf der MGU, jeweils mit Freigabe |
| Dateien | MGU-Ordner durchsuchen und herunterladen, gefundene Logs, Bibliothek auf dem Pi |
| System | Benachrichtigungen aufs Handy (ntfy: Check-Control, Service fällig, neue Fehlercodes, Reifendruck), Updates des Pi-Servers, Serverprotokoll |

Erreichbar ist sie im Tailnet unter `https://bmw-ai-pi.<tailnet>.ts.net/` oder, falls der Name gerade öffentlich auflöst, unter `http://<Tailnet-IP des Pi>:8790/` (siehe [README-CLAUDE-MCP.md](README-CLAUDE-MCP.md)).

## Einrichtung

1. **Raspberry Pi:** Pi-Server installieren und automatische Updates einrichten, siehe [README-PI-AUTOUPDATES.md](README-PI-AUTOUPDATES.md). Neue Versionen kommen danach als signierte Pakete von selbst.
2. **MGU Store:** Dieses Repository als Quelle hinzufügen (`https://github.com/NamelsMissing/mgu-chatgpt-bridge`, Branch `main`) und installieren:
   - **BMW AI Companion Agent**
   - **MGU Analysis Bridge / BMW AI**
   - **Vehicle Data**
3. **Koppeln:** In der App BMW AI Bridge Tailscale verbinden und mit dem Pi koppeln, siehe [README-INTEGRATED-TAILSCALE.md](README-INTEGRATED-TAILSCALE.md) (Stand 0.2.1; Tailscale Funnel ist inzwischen nur im Diagnosemodus und nur für den MCP-Zugang erlaubt).
4. **Benachrichtigungen (optional):** Die App ntfy (iOS/Android) installieren, das auf der Website unter System angezeigte Thema abonnieren, Benachrichtigungen einschalten und „Test senden“.
5. **Claude (optional):** Diagnosemodus auf der Website starten und den Connector in Claude hinzufügen, siehe [README-CLAUDE-MCP.md](README-CLAUDE-MCP.md).

## Sicherheit

- **Freigaben:** Claude und der Chat können Aufträge nur vorschlagen. Ausgeführt wird erst nach deiner Bestätigung auf der Website; Claude hat dafür kein Werkzeug.
- **Nur lesen:** Agent und Vehicle Data schreiben nichts ins Fahrzeug und setzen keinen Service zurück. Vehicle Data sendet an Steuergeräte ausschließlich die Lesedienste UDS 0x19 02 (Fehlerspeicher lesen) und 0x22 (Messwerte lesen); alles andere, auch Fehlerspeicher löschen (0x14), wird im Code abgelehnt und ist getestet. Fahrzeugfunktionen sind gesperrt.
- **Privat:** Die Website ist nur im Tailnet erreichbar. Über Funnel kommen ausschließlich MCP und die zugehörige Anmeldung an, und nur solange der Diagnosemodus läuft.
- **Dateibrowser:** Lesen und Herunterladen in den freigegebenen MGU-Ordnern (`/etc/cinemo`, `/etc/oap`, `/usr/lib/oap-mainapp`, `/var/log`) löst du selbst aus; dafür ist keine Freigabe nötig. Der Inhalt geht dabei nicht an Claude.

## Entwickeln und prüfen

Pi-Server und Tests brauchen Node 20 oder neuer, keine npm-Abhängigkeiten. Code auf der MGU (`native/`, `apps/`) bleibt kompatibel zu Node 8.7.

```sh
npm run test:pi                                # Pi-Server, Agent, Vehicle Data
python3 tools/build_store_app.py vehicle_data  # App-Paket bauen (wie der MGU Store)
```

Für App-Builds wird ein lokal aus dem eigenen Fahrzeug extrahiertes BMW-SDK unter `oap-sdk/` benötigt. Für Änderungen an Vehicle Data zusätzlich der Signalkatalog unter `reference/someip-interfaces.json`. Beides wird nicht veröffentlicht und steht in `.gitignore`.

## Lizenz

Copyright (C) 2026 NamelsMissing

Der eigene Code dieses Repositorys steht unter der **GNU General Public License v3.0 only** (`GPL-3.0-only`), soweit nicht ausdrücklich anders angegeben. Die vollständigen Bedingungen stehen in [LICENSE](LICENSE). Bei Weitergabe müssen die Urheber- und Lizenzhinweise erhalten bleiben.

Bestandteile von Dritten behalten ihre Lizenzen: das App-Kit in `kit/` aus [idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps) (MIT) und der QR-Code-Generator (MIT). Siehe [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Inoffizielles Projekt, nicht von BMW hergestellt oder unterstützt.

Der [Prüfbericht für BMW AI 0.9.0](docs/PRUEFBERICHT-BMW-AI-0.9.0.md) beschreibt die Fahrzeugdatenkette, die SSH-Einrichtung und die noch offenen Fahrzeugtests.
