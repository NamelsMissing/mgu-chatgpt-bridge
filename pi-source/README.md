# BMW AI Raspberry Pi – update source

This directory holds only publishable server source and a public signing key. Never commit private Ed25519 keys, ChatGPT tokens, `.env` files or user state.

To publish updates, update `VERSION` and the five application files (`server.js`, `siwc.js`, `public/app.js`, `public/index.html`, `public/style.css`). The GitHub Actions workflow signs and publishes `pi-updates/stable.json` and the matching signed ZIP. The private signing key is stored **only** in the GitHub Actions secret `BMW_AI_UPDATE_SIGNING_KEY_B64`.

`README-CLAUDE-MCP.md` in the repository root describes the diagnostic mode and the MCP endpoint for Claude.

The Raspberry Pi polls the `pi-updates` channel only when auto updates are enabled in the BMW AI web UI. No router ports are required.

## Fahrzeug, Service und Dateien (ab 0.6.0)

- **Fahrzeug:** Kilometerstand mit Verlauf, Fälligkeiten und Serviceheft. Standard: Motoröl und Ölfilter alle 12 Monate oder 8.000 km, je nachdem, was zuerst kommt. Weitere Wartungsarten mit eigenem Intervall lassen sich anlegen; eine feste Fälligkeit (z. B. laut Anzeige im Fahrzeug) gilt statt des Intervalls, bis die Wartung als erledigt eingetragen wird. Der Kilometerstand kommt von dir. Liefert der MGU-Agent unter `vehicle.mileageKm` einen Wert, wird er übernommen; der aktuelle Agent hat dafür noch keine Quelle.
- **Dateien:** Dateibrowser und Suche in den freigegebenen MGU-Ordnern (`/etc/cinemo`, `/etc/oap`, `/usr/lib/oap-mainapp`, `/var/log`). Eigene Lesezugriffe laufen ohne Freigabe; geholte Dateien liegen in der Bibliothek auf dem Pi.
- **Gefundene Logs:** Logdateien aus freigegebenen Claude-Aufträgen und aus dem MCP-Werkzeug `report_log_files` erscheinen unter „Gefundene Logs“. Sie werden per Klick oder, wenn eingeschaltet, automatisch auf den Pi geholt. Ihr Inhalt geht dabei nicht an Claude.
- **Claude:** neue Werkzeuge `get_vehicle_overview` (nur lesen, Daten vom Pi) und `report_log_files`.
