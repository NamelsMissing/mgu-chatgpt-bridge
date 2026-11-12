# BMW AI Bridge 0.2.1 – Tailscale- und Pi-Kopplung in einer einzigen MGU-App

Die App-ID bleibt **`mgu_chatgpt_bridge`**. Im iDrive ist nur **BMW AI Bridge** als Bedienoberfläche erforderlich.

## Ablauf im iDrive 7

1. Bestehende **BMW AI Bridge** im MGU Store auf 0.2.1 aktualisieren. Der **BMW AI Companion Agent** muss ebenfalls 0.2.1 sein.
2. Tailscale benötigt das eigenständige **Hintergrundtool** `iteriodev-tailscale` aus [IterioDev/car-apps](https://github.com/IterioDev/car-apps). Die separat sichtbare **Tailscale-App** `iteriodev_tailscale` ist **nicht erforderlich**. Hintergrundtool benötigt `mgu-uplink` und einen tatsächlichen Internetzugang. Der Hersteller hat die ID7-Integration bislang nicht am echten ID7-Fahrzeug verifiziert.
3. In **BMW AI Bridge** auf **Netzwerk verbinden** drücken. Die App startet den Tailscale-Login über das bereits installierte CLI-Tool und zeigt den Anmelde-QR-Code direkt im BMW-AI-Fenster. Anmeldung auf dem iPhone beim gleichen privaten Tailnet wie dem Raspberry Pi autorisieren.
4. Danach in derselben App auf **Mit Raspberry Pi koppeln** drücken. Der Agent versucht das Tailnet-Gerät **`bmw-ai-pi`** automatisch anhand des MagicDNS-Gerätenamens zu erkennen. Es wird ein einmaliger, 120 Sekunden gültiger Kopplungscode als QR-Code angezeigt.
5. QR-Code mit einem beim Tailnet angemeldeten iPhone öffnen und die Kopplung in der privaten BMW-AI-Weboberfläche bestätigen.

## Voraussetzungen Raspberry Pi

Das separate **BMW_AI_Bridge_QR_Update_v0.2.0.zip** muss **auf dem Pi** installiert sein; die MGU-Store-Aktualisierung allein installiert keine Pi-Dateien. Die vorhandene ChatGPT-Anmeldung bleibt bestehen. Tailscale Serve: **tailnet-only**, niemals Funnel.

## Fehlerdiagnose auf der MGU (ohne Geheimnisse auszugeben)

```sh
systemctl is-active mgu-ai-agent.service
systemctl is-active iteriodev-tailscale.service
/var/opt/iteriodev-tailscale/current/ts status
journalctl -u mgu-ai-agent.service -n 25 --no-pager
```

Ein fehlendes `iteriodev-tailscale.service` bedeutet: Nur das **Hintergrundtool** im Store installieren, keine separate Bedien-App.
Ein fehlender Pi in der Peerliste bedeutet: Er muss im gleichen Tailnet angemeldet und als **bmw-ai-pi** sichtbar sein.

## Sicherheit und Funktionsstand

Nur lesende MGU-Systemdiagnosen und erlaubte Dateiabrufe. Keine Steuergeräte-Schreibbefehle, keine verifizierten DDE-Livewerte oder freigeschaltete Fahrzeugkomfort-Steuerung. QR-Bedienung und die Netzwerk-Discovery wurden lokal mit simuliertem Tailscale-CLI getestet, **nicht am echten Fahrzeug**. Zugangstokens, Tailscale-Schlüssel und private Konfigurationsdateien gehören nicht ins öffentliche Repository.
