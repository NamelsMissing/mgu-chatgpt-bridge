# BMW AI Raspberry Pi – update source

This directory holds only publishable server source and a public signing key. Never commit private Ed25519 keys, ChatGPT tokens, `.env` files or user state.

To publish updates, update `VERSION` and the five application files (`server.js`, `siwc.js`, `public/app.js`, `public/index.html`, `public/style.css`). The GitHub Actions workflow signs and publishes `pi-updates/stable.json` and the matching signed ZIP. The private signing key is stored **only** in the GitHub Actions secret `BMW_AI_UPDATE_SIGNING_KEY_B64`.

`README-CLAUDE-MCP.md` in the repository root describes the diagnostic mode and the MCP endpoint for Claude.

The Raspberry Pi polls the `pi-updates` channel only when auto updates are enabled in the BMW AI web UI. No router ports are required.
