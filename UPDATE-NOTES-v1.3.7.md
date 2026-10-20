# WCRP Utilities v1.3.7

- **Transcripts:** the plain .txt dump (last 100 messages only) is replaced by a clean standalone HTML transcript of the whole ticket
  (up to 3,000 messages): header card, grouped messages, date dividers, resolved mentions, embeds, attachments, buttons, replies,
  participants. Posted to the panel's transcript channel with a summary embed. New file: `transcript.js` (keep next to `index.js`).
  Dates use the `TIMEZONE` env var (default America/New_York).
- **Claim:** the Claim Ticket button and `/ticket claim` now post:
  "Hello, my name is @user & I will be assisting you today. 👋" + the small-print pinging notice. No pings are sent.
  A ticket that is already claimed by someone else can no longer be taken over; closed tickets cannot be claimed.
