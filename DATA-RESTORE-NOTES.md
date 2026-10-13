# WCRP Utilities v1.3.6 — bundled data restore

This package includes the supplied WCRP data snapshot created at 2026-10-12T20:48:35Z.

- `bot-data.json` is the runtime state file loaded by `index.js`.
- `ticket-data.json` is the runtime ticket state file loaded by `index.js`.
- The timestamped JSON files and manifest are preserved as the original backup artifacts.

The bundled snapshot includes bot configuration/state and ticket state only. It does not include environment variables, Discord bot tokens, or Discord's live server configuration. Set the environment variables from `.env.example` in your hosting provider; do not put secrets into this ZIP.

**Important:** These are the supplied snapshot files, not a live export from Railway. If the running bot has newer state than this snapshot, preserve/download the live `bot-data.json` and `ticket-data.json` from the host before replacing anything. Do not deploy this snapshot over newer live data without comparing first.
