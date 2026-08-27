# Titan Moderation & Support Bot

Standalone Discord.js 14 bot with local JSON persistence. PostgreSQL is not required.

## Included

### Moderation
- `/ban user`, `/ban logs`, `/ban status`
- `/unban`
- `/kick`
- `/timeout`
- `/untimeout`
- `/warn`, `/warnings`, `/clearwarn`
- `/purge`

### Global enforcement with approval workflow
- `/global ban`
- `/global kick`
- `/global timeout`
- `/unglobal ban`
- `/unglobal timeout`
- Requests appear in the `/ban logs` channel with **Approve**, **Deny**, and **Advance to Ownership** buttons.
- Ownership-stage decisions require a user listed in `OWNER_IDS`.
- Global ban requests automatically create a proof thread that mentions the requester and includes a **Remind for Proof** button.
- Global bans are remembered and re-applied if the banned user joins another server where the bot is present.
- Global timeouts are remembered until their expiry and re-applied when a user joins while the timeout is still active.

### Tickets
- `/ticket-panel create|list|hub|delete`
- `/ticket claim|close|reopen|rename|delete`
- Configurable support roles, ping roles, category, transcript channel, embed, and button label.
- Claiming a ticket automatically renames it to the staff handler.
- Closing creates a text transcript in the configured transcript channel.
- Ticket pings use Discord allowed-mentions so selected roles are actually notified.

### Roles
- `/request role` for member role requests with optional notes.
- `/request logs` and `/role logs` configure the role-request log channel.
- Staff can approve or deny role requests; approval records who approved it.
- `/role add`, `/role remove`
- `/temp role` with automatic expiry and restart-safe scheduling.
- `/auto-role set|disable|status`

### Community
- `/welcome setup|disable|test|status`
- `/giveaway start|end|reroll` with entry buttons and automatic winner selection.
- `/serverlog setup|status|disable`
- Server logging supports member joins/leaves/updates, message delete/edit/bulk-delete, bans/unbans, channel/role changes, server updates, thread and invite events.

### Utilities
- `/help`
- `/features`
- `/ping`
- `/server-info`
- `/user-info`

## Setup

1. Create a Discord application and bot.
2. Enable Server Members Intent and Message Content Intent.
3. Copy `.env.example` to `.env` or set the variables in Railway.
4. Run `npm install`.
5. Run `npm start`.

For Railway, attach a persistent volume if you want `bot-data.json` and `ticket-data.json` to survive container replacement.

## Permissions

Give the bot the permissions required for the features you use, including View Channel, Send Messages, Embed Links, Attach Files, Read Message History, Manage Channels, Manage Messages, Manage Roles, Ban Members, Kick Members, Moderate Members, and Create Public Threads.

The bot's highest role must be above roles it needs to assign/remove.
