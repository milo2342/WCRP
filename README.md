# Titan Moderation & Tickets — Advanced Ticket Designer

This build includes the full moderation/ticket bot plus a redesigned ticket-panel system.

## Ticket panel designer

`/ticket-panel create` supports:
- custom panel name, title and description
- support roles, ping roles, ticket category and transcript channel
- custom welcome message
- custom button label
- button style/colour: Blurple, Green, Red, Grey
- optional button emoji
- custom embed hex colour
- embed colour presets: Blurple, Purple, Pink, Blue, Teal, Green, Gold, Orange, Red, Grey, White

`/ticket-panel edit` lets you change the title, description, embed colour, button label/style/emoji and ticket welcome message for an existing panel.

`/ticket-panel hub` creates a single polished Ticket Selection hub with up to five department buttons. Each button inherits its panel's selected button colour/style.

`/ticket-panel hub-edit` edits an existing hub's title, description, embed colour, or panel list.

Panel edits automatically refresh any saved hubs that use that panel.

## Ticket styling

The ticket hub is designed around a professional support-centre layout: one main embed, clear department sections, branded author/footer, timestamp, and a clean button row underneath instead of multiple bland embeds.

## Deployment

Use Node.js 20+ and set:
- `DISCORD_BOT_TOKEN`
- `DISCORD_CLIENT_ID`
- `OWNER_IDS`

The bot registers commands separately in every server it is in. Ticket settings are stored per server.
