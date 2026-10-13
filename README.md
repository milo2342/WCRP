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


## v1.3.3 permission UX update
- `/permissions set` now uses a dropdown of supported command names instead of free-text command entry.
- `/permissions set-all` configures a role that bypasses ordinary command restrictions. It does not grant the separately protected `/global ban`, `/global kick`, or `/global timeout` actions.
- `/permissions list` reports the exemption role and individual command entries.


### v1.3.3 permission selector update

`/permissions set` and `/permissions clear` now use a dropdown of 25 commonly managed commands, including `auto-role`, ticket/request commands, role tools, sticky messages, moderation, quarantine controls, and server/user info. Global moderation and owner-only security setup remain excluded from ordinary command-role configuration.

### v1.3.6 Global moderation update
Global ban attempts and approved global moderation actions now run across connected guilds concurrently to reduce delay. Per-guild failures remain recorded, and success embeds use WCRP branding plus the configured completion GIF. A clean completion message is shown only when the action has zero reported failures.


## Bundled data snapshot
This flat package includes `bot-data.json` and `ticket-data.json` initialized from the supplied 2026-10-12 backup, plus the original timestamped JSON artifacts and manifest. Review `DATA-RESTORE-NOTES.md` before deploying: this snapshot may be older than live host data, and environment secrets are not included.
