# Titan Moderation & Tickets Bot — Ticket UI Edition

This build includes the advanced moderation, global approval, ticket, giveaway, role, welcome, logging, and utility systems.

## Ticket panel appearance

`/ticket-panel create` now supports:
- `embed-color` — any 6-digit hex colour such as `#7C3AED`
- `button-style` — Blurple, Green, Red, or Grey (Discord's supported button colours)
- `button-emoji` — optional emoji
- `welcome-message` — custom message shown when a ticket opens

`/ticket-panel edit` lets staff change those appearance options later.

`/ticket-panel hub` posts a single polished ticket-selection embed with up to 5 department buttons. Each department button keeps its own configured button style and emoji.

Tickets remain isolated per Discord server. Each server can configure its own panels, categories, support roles, ping roles, transcripts, colours, and welcome messages.

## Environment

Required:
- `DISCORD_BOT_TOKEN`
- `DISCORD_CLIENT_ID`

Optional:
- `OWNER_IDS` — comma-separated Discord user IDs allowed for final ownership approval.
- `DISCORD_GUILD_ID` — retained for compatibility; command registration is not locked to one guild in this build.
