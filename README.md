# Titan Moderation, Tickets & Global v2

This build includes the advanced moderation, ticket, giveaway, role, welcome and logging systems.

## Ticket presentation
Ticket hubs now use a single polished Support Center embed with a department dropdown instead of stacking separate bland panels. Each ticket panel can also define a custom welcome message, and opened tickets receive a professional welcome embed with ticket metadata and action buttons.

### Ticket welcome placeholders
- `{user}` — mentions the ticket opener
- `{username}` — opener username
- `{server}` — server name
- `{ticket}` — ticket number

The ticket panel `/ticket-panel create` command supports a `welcome-message` option for this.
