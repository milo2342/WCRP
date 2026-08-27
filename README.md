# Titan Moderation Tickets Global — Advanced Build

A multi-server Discord moderation and ticket bot with local JSON persistence.

## Global moderation approval workflow

Global moderation requests use a review embed with a detailed target, requester, reason, action, approval stage, status, request ID, optional timeout duration, and execution results.

Buttons:
- **Approve** — executes the approved global action and updates the same embed to `REQUEST APPROVED`.
- **Deny** — updates the same embed to `REQUEST DENIED` and removes the action buttons.
- **Advance to Ownership** — updates the same embed to `WAITING FOR OWNERSHIP APPROVAL` and removes the escalation button. Only configured owners can approve/deny at this stage.

Approving first changes the message to `ACTION PROCESSING` immediately so long-running cross-server operations do not look stuck.

Global bans also create a proof thread under the approval message with a `Remind for Proof` button.

## Global permissions

Use `/global setup` to add roles that can submit global moderation requests. Use `/global remove-role` and `/global roles` to manage the configured roles.

`OWNER_IDS` is the final ownership approval list.

## Multi-server

Commands are registered per guild the bot is currently in. There is no required single-guild lock for the ticket system.

## Required Railway variables

```env
DISCORD_BOT_TOKEN=
DISCORD_CLIENT_ID=
OWNER_IDS=
```

## Intents

Enable these in the Discord Developer Portal:
- Server Members Intent
- Message Content Intent
- Presence Intent

The bot must also have appropriate moderation, role, channel, thread, and message permissions.
