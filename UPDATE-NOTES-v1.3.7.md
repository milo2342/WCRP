# WCRP Utilities v1.3.7

- **Transcripts:** the plain .txt dump (last 100 messages only) is replaced by a clean standalone HTML transcript of the whole ticket
  (up to 3,000 messages): header card, grouped messages, date dividers, resolved mentions, embeds, attachments, buttons, replies,
  participants. Posted to the panel's transcript channel with a summary embed. New file: `transcript.js` (keep next to `index.js`).
  Dates use the `TIMEZONE` env var (default America/New_York).
- **Claim:** the Claim Ticket button and `/ticket claim` now post:
  "Hello, my name is @user & I will be assisting you today. 👋" + the small-print pinging notice. No pings are sent.
  A ticket that is already claimed by someone else can no longer be taken over; closed tickets cannot be claimed.

## Restored after a bad merge
- Claim Ticket button and `/ticket claim` use the new greeting again (the old "Ticket Claimed" embed is gone).
- HTML transcripts are active again (createTranscript was reverted to the old text dump).
- `/ticket features` (support team guide) is kept and is now a nicer orange embed. `/ticket move` is untouched.
- **Opener DM:** when a ticket is closed (button or `/ticket close`) the opener is also DMed a copy of the HTML transcript. Skipped silently if their DMs are closed. Works even if the panel has no transcript channel.
