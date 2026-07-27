# @photon-ai/chat-adapter-imessage

iMessage community adapter for [Chat SDK](https://chat-sdk.dev/docs). Built on [spectrum-ts](https://github.com/photon-hq/spectrum-ts), Photon's unified messaging SDK. Supports **cloud** ([Spectrum Cloud](https://app.photon.codes)) and **self-hosted** iMessage.

## Installation

```bash
pnpm add chat @photon-ai/chat-adapter-imessage
```

## Usage

The adapter has two modes:

- **Cloud** (recommended) — connects to [Spectrum Cloud](https://app.photon.codes) with a project ID + secret. Runs anywhere.
- **Self-hosted** — connects to your own `@photon-ai/advanced-imessage` gRPC endpoint.

The mode is auto-detected from environment variables (see [Configuration](#configuration)).

### Cloud mode

```typescript
import { Chat } from "chat";
import { createiMessageAdapter } from "@photon-ai/chat-adapter-imessage";

const bot = new Chat({
  userName: "mybot",
  adapters: {
    imessage: createiMessageAdapter({
      projectId: process.env.IMESSAGE_PROJECT_ID,
      projectSecret: process.env.IMESSAGE_PROJECT_SECRET,
    }),
  },
});

bot.onNewMention(async (thread, message) => {
  await thread.post("Hello from iMessage!");
});
```

Credentials can also be resolved lazily when the adapter is first used, which
is useful when retrieving them from a credential broker:

```typescript
createiMessageAdapter({
  credentials: async () => {
    const value = await getToken("photon/my-agent", {
      subject: { type: "app" },
    });

    return parsePhotonCredential(value);
  },
});
```

The provider must return `{ projectId, projectSecret }`.

## Setup

### Cloud mode

1. Sign up at [app.photon.codes](https://app.photon.codes) to get your **project ID** and **project secret**.
2. Set `IMESSAGE_PROJECT_ID` and `IMESSAGE_PROJECT_SECRET`.

### Self-hosted mode

Point the adapter at your own `@photon-ai/advanced-imessage` gRPC server.

1. Set `IMESSAGE_SERVER_URL` to the server's gRPC address as `host:port` (e.g. `imessage.example.com:443`).
2. Set `IMESSAGE_API_KEY` to the server's auth token.

> ⚠️ **Transport change.** Previous versions of this adapter spoke HTTP/Socket.IO. It now uses gRPC via spectrum-ts, so `IMESSAGE_SERVER_URL` must be a gRPC `host:port`, **not** an `https://` URL. A bare host gets `:443` appended; any URL scheme is stripped.

For advanced multi-number setups, pass explicit `clients` instead:

```typescript
createiMessageAdapter({
  clients: [
    { address: "imessage.example.com:443", token: "…", phone: "+1234567890" },
  ],
});
```

## Receiving messages

There are two ways to receive inbound messages:

- **Webhooks** (recommended for serverless) — Spectrum Cloud delivers each message to an HTTPS endpoint as signed JSON. No long-lived connection or cron job. Remote (cloud) mode only.
- **Gateway listener** — `startGatewayListener()` consumes spectrum-ts's message stream in real time. Works in cloud and self-hosted modes; in serverless it needs a cron job to stay connected.

## Webhooks

In remote (cloud) mode, [Spectrum Cloud](https://app.photon.codes) can deliver inbound messages to your HTTPS endpoint as signed JSON — see the [webhook docs](https://photon.codes/docs/webhooks/overview). This is the simplest path for serverless: no cron, no persistent connection.

### 1. Register the endpoint

In the [Spectrum Cloud dashboard](https://app.photon.codes), register your endpoint URL (public HTTPS only) and copy the per-webhook **signing secret** — it is shown only once.

### 2. Configure the secret

Set `IMESSAGE_WEBHOOK_SECRET` to that signing secret. The adapter verifies the `X-Spectrum-Signature` HMAC on every delivery and rejects unsigned, mismatched, or stale (>5 min) requests.

```bash
IMESSAGE_WEBHOOK_SECRET=whsec_...
```

### 3. Create the webhook route

```typescript
// app/api/imessage/webhook/route.ts
import { after } from "next/server";
import { bot } from "@/lib/bot";

export async function POST(request: Request): Promise<Response> {
  return bot.webhooks.imessage(request, {
    waitUntil: (task) => after(() => task),
  });
}
```

`bot.webhooks.imessage` calls the adapter's `handleWebhook`: it verifies the signature, parses the `messages` event, and routes the message into your bot. When a trusted gateway verifies Photon before forwarding, pass `webhookVerifier`; it receives the request and exact raw body, takes precedence over `webhookSecret`, and must return `true`. Processing runs in the background via `waitUntil`, so the endpoint acknowledges immediately. Spectrum Cloud retries failed deliveries with backoff and delivers at-least-once — dedupe on `X-Spectrum-Webhook-Id` + `message.id` if you need exactly-once side effects.

### Replying

A webhook delivery carries no live connection, but your bot can still respond: the adapter rebuilds the thread — **DM or group** — from its chat GUID via spectrum-ts's `space.get` and sends, reacts, edits, and shows typing — no gateway needed.

```typescript
bot.onNewMention(async (thread, message) => {
  await thread.post("Got it!"); // works directly from a webhook delivery
});
```

The rebuild needs spectrum-ts to know which iMessage line the chat belongs to; with **multiple lines** configured, an unseen thread can't be resolved and the adapter throws `NotImplementedError` — respond within a thread received over the [gateway listener](#gateway-setup-for-serverless) instead (see [Limitations](#limitations)).

## Gateway setup for serverless

### 1. Create Gateway route

```typescript
// app/api/imessage/gateway/route.ts
import { after } from "next/server";
import { bot } from "@/lib/bot";

export const maxDuration = 800;

export async function GET(request: Request): Promise<Response> {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return new Response("CRON_SECRET not configured", { status: 500 });
  }

  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const durationMs = 600 * 1000;

  return bot.adapters.imessage.startGatewayListener(
    { waitUntil: (task) => after(() => task) },
    durationMs
  );
}
```

### 2. Configure Vercel Cron

```json
// vercel.json
{
  "crons": [
    {
      "path": "/api/imessage/gateway",
      "schedule": "*/9 * * * *"
    }
  ]
}
```

This runs every 9 minutes, ensuring overlap with the 10-minute listener duration.

### 3. Environment variables

`CRON_SECRET` is automatically added by Vercel when you configure cron jobs.

## Configuration

| Option | Required | Description |
|--------|----------|-------------|
| `projectId` | Cloud | Spectrum Cloud project ID. Auto-detected from `IMESSAGE_PROJECT_ID` |
| `projectSecret` | Cloud | Spectrum Cloud project secret. Auto-detected from `IMESSAGE_PROJECT_SECRET` |
| `credentials` | Cloud | Sync or async provider for lazy `{ projectId, projectSecret }` resolution |
| `serverUrl` | Self-host | gRPC `host:port` of your iMessage server. Auto-detected from `IMESSAGE_SERVER_URL` |
| `apiKey` | Self-host | Auth token for the self-hosted server. Auto-detected from `IMESSAGE_API_KEY` |
| `clients` | No | Explicit `{ address, token, phone }[]` for multi-number self-host setups |
| `phone` | No | Routing/identity phone for legacy self-host (defaults to `"shared"`). Auto-detected from `IMESSAGE_PHONE` |
| `webhookSecret` | No | Per-webhook signing secret for verifying Spectrum Cloud deliveries. Required to receive [webhooks](#webhooks) unless `webhookVerifier` is supplied. Auto-detected from `IMESSAGE_WEBHOOK_SECRET` |
| `webhookVerifier` | No | Sync or async trusted-forwarder verifier `(request, rawBody) => boolean`. Takes precedence over `webhookSecret`; throw or return `false` to reject. |
| `logger` | No | Logger instance (defaults to `ConsoleLogger("info")`) |

## Environment variables

```bash
# .env.local
# Cloud (recommended)
IMESSAGE_PROJECT_ID=...
IMESSAGE_PROJECT_SECRET=...

# Self-hosted (alternative)
IMESSAGE_SERVER_URL=imessage.example.com:443   # gRPC host:port (NOT an https URL)
IMESSAGE_API_KEY=...
IMESSAGE_PHONE=+1234567890                      # optional, for multi-number routing

# Webhooks (remote/cloud only; see "Webhooks")
IMESSAGE_WEBHOOK_SECRET=whsec_...               # per-webhook signing secret
```

## Features

| Feature | Supported |
|---------|-----------|
| Mentions | DMs only |
| DMs | Yes |
| Open DM (cold-start) | Yes (`openDM`) |
| File uploads | Yes (send) |
| Reactions (add) | Yes |
| Reactions (remove) | Yes (session-added tapbacks) |
| Message editing | Yes |
| Message delete | Yes (iMessage unsend window) |
| Mark read | Yes (`markRead`) |
| Typing indicator | Yes |
| Message effects | Yes (`sendEffect`) |
| Mini-app cards | Yes (`sendMiniApp`) |
| Voice messages | Yes (`sendVoice`) |
| Chat background | Yes (`setBackground`) |
| Modals | Limited |
| Fetch single message | Yes (`fetchMessage`) |
| Message history | No |
| Thread/chat info | No |
| Cards | Mini-app cards only (`sendMiniApp`) |
| Streaming | No |
| Ephemeral messages | No |
| Webhooks | Yes (Spectrum Cloud delivery) |

## Modals (Limited)

The adapter supports limited modal functionality by mapping the Chat SDK's `openModal()` to iMessage native polls. Only `Select` children are supported — the first `Select` in the modal becomes a poll.

- `Modal.title` becomes the poll question.
- `Select.options` become the poll choices (2–10 supported).
- Votes trigger `onModalSubmit` with the selected option's `value`.

```typescript
import { Chat, Modal, Select, SelectOption } from "chat";
import { createiMessageAdapter } from "@photon-ai/chat-adapter-imessage";

const bot = new Chat({
  userName: "mybot",
  adapters: {
    imessage: createiMessageAdapter(),
  },
});

bot.onNewMention(async (thread, message) => {
  await message.openModal(
    Modal({
      callbackId: "fav-color",
      title: "What is your favorite color?",
      children: [
        Select({
          id: "color",
          label: "Pick a color",
          options: [
            SelectOption({ label: "Red", value: "red" }),
            SelectOption({ label: "Blue", value: "blue" }),
            SelectOption({ label: "Green", value: "green" }),
          ],
        }),
      ],
    })
  );
});

bot.onModalSubmit("fav-color", async (event) => {
  const color = event.values.color; // "red", "blue", or "green"
});
```

**Not supported:** `Select.placeholder`/`label`, `TextInput`, `RadioSelect`, `Modal.submitLabel`/`closeLabel`, more than one `Select`, and poll vote *deselection*. Polls in the same chat must have distinct titles (votes are matched back to the modal by title).

## Tapback reactions

iMessage uses tapbacks instead of emoji reactions. Outbound reactions map standard emoji names to iMessage tapbacks:

| Emoji name | Tapback |
|------------|---------|
| `love` / `heart` | Love |
| `like` / `thumbs_up` | Like |
| `dislike` / `thumbs_down` | Dislike |
| `laugh` | Laugh |
| `emphasize` / `exclamation` | Emphasize |
| `question` | Question |

## Message effects

iMessage expressive-send effects animate a message when it arrives. The adapter exposes them through `sendEffect(threadId, message, effect)` — an adapter-specific extra (there is no first-class Chat SDK slot for effects). It sends the text with the effect attached and returns the sent message.

```typescript
import { createiMessageAdapter, iMessageEffect } from "@photon-ai/chat-adapter-imessage";

const adapter = createiMessageAdapter();

bot.onNewMention(async (thread) => {
  // Friendly name…
  await adapter.sendEffect(thread.id, "🎉 Task complete!", "confetti");
  // …or the typed constant:
  await adapter.sendEffect(thread.id, "🎉 Task complete!", iMessageEffect.confetti);
});
```

The `effect` argument accepts a friendly name or a value from the re-exported `iMessageEffect` map. Full-screen effects: `confetti`, `fireworks`, `balloons`, `heart`, `lasers`, `celebration`, `sparkles`, `spotlight`, `echo`. Bubble effects: `slam`, `loud`, `gentle`, `invisible` (invisible ink). Effects attach to text only, so `sendEffect` requires non-empty text content; an unknown effect throws a `ValidationError`.

## Mini-app cards

Mini-app cards are native `MSMessageExtension` balloons — a rich card with a tap-through URL, the closest iMessage gets to a Slack-style rich card rather than a bare link. The adapter exposes them through `sendMiniApp(threadId, card)` — an adapter-specific extra (there is no first-class Chat SDK slot for cards).

`sendMiniApp` takes **either** a bare URL **or** a fully-specified card.

### Just a URL (`app(url)`)

The lightweight form: pass a URL string and iMessage renders it as a mini-app — no extension identifiers required. You can also pass a `Promise<string>` or a thunk (`() => string | Promise<string>`), so the link can be minted at send time (e.g. a signed URL).

```typescript
import { createiMessageAdapter } from "@photon-ai/chat-adapter-imessage";

const adapter = createiMessageAdapter();

bot.onNewMention(async (thread) => {
  await adapter.sendMiniApp(thread.id, "https://example.com/menu");

  // …or compute the URL lazily at send time:
  await adapter.sendMiniApp(thread.id, async () => mintSignedLink(thread.id));
});
```

### A full card (`customizedMiniApp`)

Pass an object to control the bubble's image, captions, and the exact iMessage extension that opens on tap.

```typescript
await adapter.sendMiniApp(thread.id, {
  appName: "Poll Kit",
  teamId: "TEAM123",
  extensionBundleId: "com.example.pollkit.MessagesExtension",
  url: "https://example.com/poll/42",
  appStoreId: 1_234_567, // optional — for recipients without the extension
  layout: {
    caption: "Pizza night?",
    subcaption: "Tap to vote",
    imageTitle: "Friday",
    image: pngBytes, // Uint8Array | Buffer | ArrayBuffer | Blob | FileUpload
    summary: "Vote on Friday's dinner",
  },
});
```

`appName`, `teamId`, and `extensionBundleId` identify the iMessage extension that opens (receiving `url`) when the recipient taps the card; the server builds the matching `MSMessageExtensionBalloonPlugin` id from `teamId` + `extensionBundleId`. Every `layout` field is optional. The `url` accepts a string or `URL` and is validated; a missing required field or an invalid URL throws a `ValidationError`.

## Chat background

iMessage lets a conversation carry its own wallpaper — a touch with no analog on the plain-text competitors. The adapter exposes it through `setBackground(threadId, input, options?)` — an adapter-specific extra (there is no first-class Chat SDK slot for it). It is fire-and-forget: iMessage acknowledges the control signal without returning a message, so the call resolves to `void`.

```typescript
import { readFile } from "node:fs/promises";

// From image bytes (Uint8Array | Buffer | ArrayBuffer | Blob | FileUpload).
await adapter.setBackground(thread.id, await readFile("./wallpaper.jpg"), {
  mimeType: "image/jpeg",
});

// From an http(s) URL, fetched at send time.
await adapter.setBackground(thread.id, "https://example.com/wallpaper.jpg");

// Remove the current background.
await adapter.setBackground(thread.id, "clear");
```

Pass the literal `"clear"` to remove the current background, in-memory image bytes, or an `http(s)` URL (a `URL` or a string) that spectrum-ts fetches at send time. Image bytes need an `image/*` MIME type — supply `options.mimeType` (e.g. `"image/jpeg"`) or an `options.name` with an image extension when it can't be inferred. Local file-path strings are rejected — read the file into bytes and pass those instead. A non-image MIME type, an unresolvable MIME type, or a non-`http(s)` string throws a `ValidationError`.

## Limitations

- **Cold sends need a resolvable line.** The adapter rebuilds a thread — DM or group — from its chat GUID via spectrum-ts's `space.get`, so it can send, react, edit, and show typing even into a thread it hasn't seen this session, including a [webhook](#webhooks) delivery. With **multiple iMessage lines** configured, spectrum-ts cannot infer which line an unseen chat belongs to, so cold sends there throw `NotImplementedError` — respond within a received message's thread instead.
- **No message history.** `fetchMessages` is not supported — spectrum-ts exposes no paginated history API. Single messages resolve via `fetchMessage` (from the session cache or spectrum-ts's by-id lookup).
- **No thread/chat info.** `fetchThread` is not supported.
- **Session-scoped delete & reaction removal.** `deleteMessage` unsends a message resolved from this session (subject to iMessage's ~2-minute unsend window); `removeReaction` retracts a tapback only if it was added via `addReaction` earlier in this session — spectrum-ts exposes no by-target reaction lookup.
- **Formatting.** Markdown-typed content (`{ markdown }` or `{ ast }`) renders as native iMessage styled text — bold, italics, links, and lists — via spectrum-ts's `markdown()` builder. Plain strings and `{ raw }` are sent as-is (never reinterpreted as Markdown). Inbound messages always surface as plain text.
- **Cards.** iMessage has no structured card layouts.

## Breaking changes

This version re-platforms the adapter onto **spectrum-ts**. If you are upgrading:

- **Local (on-device) mode removed** — `local: true`, and `IMESSAGE_LOCAL` set to any value other than `"false"`, now throw. Use Spectrum Cloud or a self-hosted gRPC endpoint; `local: false` and `IMESSAGE_LOCAL=false` are still accepted as no-ops.
- **Dependency** — replaces `@photon-ai/imessage-kit` + `@photon-ai/advanced-imessage-kit` with `@spectrum-ts/core` + `@spectrum-ts/imessage`
- **`IMESSAGE_SERVER_URL` is now a gRPC `host:port`** (self-host), not an `https://` / Socket.IO URL.
- **New cloud path** — set `IMESSAGE_PROJECT_ID` + `IMESSAGE_PROJECT_SECRET` for Spectrum Cloud.
- **Unsupported capabilities** (throw `NotImplementedError`): `fetchMessages` and `fetchThread` — spectrum-ts exposes no paginated history or chat-info API. Cold `postMessage` works for DMs and groups alike (rebuilt from the chat GUID — see [Limitations](#limitations)).
- **Newly supported on spectrum-ts**: `deleteMessage` (unsend), `removeReaction` (retract a session-added tapback), `openDM` (cold-start a DM from a handle), `fetchMessage` (single message by id), and `markRead` — see [Features](#features).
- **`adapter.sdk` → `adapter.app`** — the adapter now exposes the underlying `SpectrumInstance` as `adapter.app` (null until `initialize()`).

## Troubleshooting

### "serverUrl is required"

- Provide cloud credentials (`IMESSAGE_PROJECT_ID` + `IMESSAGE_PROJECT_SECRET`), or a self-host `IMESSAGE_SERVER_URL` + `IMESSAGE_API_KEY`.

### "Local (on-device) mode was removed"

- The adapter no longer runs against the on-device Messages database. Remove `local: true` (and any `IMESSAGE_LOCAL` value other than `"false"`, which is still accepted as a no-op) and provide cloud or self-host credentials instead.

### Self-host connection issues

- Confirm `IMESSAGE_SERVER_URL` is a gRPC `host:port` (e.g. `imessage.example.com:443`), not an `https://` URL.
- Verify the token matches your server's credentials.

### `NotImplementedError` from `fetchMessages` / `fetchThread`

- These are not supported by spectrum-ts. See [Limitations](#limitations).

### `NotImplementedError` from `deleteMessage` / `removeReaction` / `markRead`

- These are session-scoped. `deleteMessage` and `markRead` need the target message to have been seen this session (and delete is bound by iMessage's ~2-minute unsend window); `removeReaction` needs the tapback to have been added via `addReaction` this session. See [Limitations](#limitations).

## License

MIT
