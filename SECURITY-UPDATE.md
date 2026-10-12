# WCRP Utilities v1.3.1 — Security and Setup

## Security boundaries
- Global moderation is restricted to the main guild configured in `index.js`.
- The primary owner ID and main guild ID remain hard-coded in the source. Change them only if you intentionally want a different owner/server.
- `/global ban`, `/global kick`, and `/global timeout` require the configured Global Moderation Access role or a specific role/user allowlist configured through `/permission set`.
- `/security setup` controls protected Global Access, Grant Authority, Quarantine roles, and the general security log channel.
- The general security log channel is for security incidents such as role grants, quarantine actions, blocked access, and protected-role changes. Global ban review records use the separate `/ban-logs` channel.
- Unknown audit-log attribution no longer causes the bot to quarantine the role recipient automatically. It still removes an unauthorized protected role where possible and records the incident.
- Owner-only `/data backup` and `/data status` remain available. Backups exclude environment variables and bot tokens.

## Setup after updating
1. Back up `bot-data.json` and `ticket-data.json` before starting the new build.
2. Ensure the bot has the required Discord permissions and its highest role is above roles it must manage.
3. Run `/security setup` in the main guild and select the Global Access role, Grant Authority role, Quarantine role, and a general security log channel.
4. Run `/ban-logs set` and select a separate channel for global ban review embeds and controls.
5. Use `/permission set` to configure authorized roles/users for `role-assign`, `role-request-approve`, `ban-approve`, `ticket-create`, `sticky-manage`, or the specific global action categories.
6. For immediate global bans, the bot needs Ban Members in each guild it should process. For denied requests, it needs Ban Members/Unban capability to reverse the bans it created.
7. For evidence threads, the review channel needs Create Public Threads and Send Messages. For invite delivery, a suitable channel needs Create Instant Invite; the target must allow DMs for delivery to succeed.

## Global ban behavior
- The ban attempt occurs immediately when `/global ban` is run, before the review decision.
- Each request is persisted before guild operations. It tracks newly banned guild IDs separately from guilds where the user was already banned.
- If denied, the bot only attempts to unban guilds recorded as newly banned by that request. Pre-existing bans are not reversed.
- The bot records partial results and does not claim total success when some guild operations fail.
- If the review post fails, the bot attempts rollback and reports any rollback failures for manual follow-up.
- On denial, the bot attempts to create a one-use invite and DM it to the target. Invite creation and DMs can fail because of permissions, server configuration, or user privacy settings.

## Validation
The included `npm run check` performs `node --check index.js` and the static self-test. It does not log into Discord, exercise live guild permissions, test Railway, or deploy the bot.

**Quarantine safety hotfix:** protected-role grant/tamper events are logged for owner review; the bot removes an unauthorized protected role and attempts rollback of protected-role edits, but does not automatically quarantine the grantor or re-apply quarantine when the quarantine role is removed. Manual owner-triggered quarantine remains available. This avoids audit-log attribution errors and prevents ordinary moderation-role holders from being automatically stripped/quarantined by these event handlers.
