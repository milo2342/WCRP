# WCRP Utilities v1.3.1

Discord.js v14 bot source. This ZIP is intentionally flat: all files are at the archive root.

## Install and run
- Requires Node.js 20 or newer.
- Copy `.env.example` to `.env` and fill in `DISCORD_BOT_TOKEN` and `DISCORD_CLIENT_ID`.
- Install dependencies with `npm install`.
- Run `npm run check`.
- Start with `npm start`.

## Required configuration
- In the main guild, run `/security setup` and choose the Global Access, Grant Authority, Quarantine roles and the general security log channel.
- Run `/ban-logs set` to choose a separate global ban review channel.
- Use `/permission set` to allow the appropriate roles/users to create tickets, approve role requests, assign roles, approve global bans, and manage sticky messages.
- Sticky messages are persisted in `bot-data.json`. Runtime data files are created by the bot on first run and are intentionally not shipped in the source ZIP.

See `SECURITY-UPDATE.md` and `UPDATE-NOTES-v1.3.1.md` for behavior and setup details.

## Validation limits
The included check script validates JavaScript syntax and static source assertions. This package has not been connected to a live Discord server or Railway in this build session.

**Quarantine safety hotfix:** protected-role grant/tamper events are logged for owner review; the bot removes an unauthorized protected role and attempts rollback of protected-role edits, but does not automatically quarantine the grantor or re-apply quarantine when the quarantine role is removed. Manual owner-triggered quarantine remains available. This avoids audit-log attribution errors and prevents ordinary moderation-role holders from being automatically stripped/quarantined by these event handlers.
