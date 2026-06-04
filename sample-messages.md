# iMessage Message Reference

Messages are received via `startGatewayListener()`, which consumes spectrum-ts's
message stream and delivers each inbound message to your bot as a Chat SDK
`Message`. There is no raw webhook payload to handle — `handleWebhook()` returns
`501`.

## Inbound message (as delivered to Chat SDK)

A direct message arrives as a Chat SDK `Message`:

```jsonc
{
  "id": "p:0/XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX",
  "threadId": "imessage:iMessage;-;+1234567890",
  "text": "Hello!",
  "author": {
    "userId": "+1234567890",
    "userName": "+1234567890",
    "fullName": "+1234567890",
    "isBot": false,
    "isMe": false
  },
  "attachments": [],
  "metadata": { "dateSent": "2026-02-28T12:00:00.000Z", "edited": false },
  "isMention": true
  // `raw` holds the underlying spectrum-ts Message
}
```

A group message is the same shape with a `;+;` `threadId` and `isMention: false`.
The original sender's display name is not exposed by spectrum-ts, so `userName`
and `fullName` fall back to the handle (phone/email).

## Attachments

Attachments are surfaced as metadata on the Chat SDK `Message`:

```jsonc
{
  "attachments": [
    { "type": "image", "name": "photo.jpg", "mimeType": "image/jpeg", "size": 12345 }
  ]
}
```

`type` is one of `image` / `video` / `audio` / `file`, inferred from the MIME type.

## Poll votes

iMessage poll votes (from `openModal()` polls) are **not** delivered as messages.
They arrive as spectrum-ts `poll_option` content and are routed to your
`onModalSubmit("<callbackId>")` handler with the selected option's `value`.

## Chat GUID Patterns

- DM: `iMessage;-;+1234567890` (`;-;` = direct message)
- Group: `iMessage;+;chat493787071395575843` (`;+;` = group chat)
- SMS DM: `SMS;-;+1234567890`
- SMS Group: `SMS;+;chat987654321`
