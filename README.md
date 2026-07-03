# @photon-ai/chat-adapter-imessage

iMessage community adapter for [Chat SDK](https://chat-sdk.dev/docs). Built on [spectrum-ts](https://github.com/photon-hq/spectrum-ts), Photon's unified messaging SDK. Supports **cloud** ([Spectrum Cloud](https://app.photon.codes)), **self-hosted**, and **local** (on-device, macOS) iMessage.

## Installation

```bash
pnpm add chat @photon-ai/chat-adapter-imessage
```

## Usage

The adapter has three modes:

- **Cloud** (recommended) — connects to [Spectrum Cloud](https://app.photon.codes) with a project ID + secret. Runs anywhere.
- **Self-hosted** — connects to your own `@photon-ai/advanced-imessage` gRPC endpoint.
- **Local** — runs directly on a Mac, reading the local iMessage database. macOS only.

The mode is auto-detected from environment variables (see [Configuration](#configuration)).

### Cloud mode

```typescript
import { Chat } from "chat";
import { createiMessageAdapter } from "@photon-ai/chat-adapter-imessage";

const bot = new Chat({
  userName: "mybot",
  adapters: {
    imessage: createiMessageAdapter({
      local: false,
      projectId: process.env.IMESSAGE_PROJECT_ID,
      projectSecret: process.env.IMESSAGE_PROJECT_SECRET,
    }),
  },
});

bot.onNewMention(async (thread, message) => {
  await thread.post("Hello from iMessage!");
});
```

### Local mode

For development or self-hosted deployments on a Mac. Reads from the local iMessage database and sends via the on-device APIs. Must run on macOS with **Full Disk Access** granted.

```typescript
import { Chat } from "chat";
import { createiMessageAdapter } from "@photon-ai/chat-adapter-imessage";

const bot = new Chat({
  userName: "mybot",
  adapters: {
    imessage: createiMessageAdapter({ local: true }),
  },
});

bot.onNewMention(async (thread, message) => {
  await thread.post("Hello from iMessage!");
});
```

## Setup

### Cloud mode

1. Sign up at [app.photon.codes](https://app.photon.codes) to get your **project ID** and **project secret**.
2. Set `IMESSAGE_PROJECT_ID` and `IMESSAGE_PROJECT_SECRET`.
3. Set `IMESSAGE_LOCAL=false`.

### Self-hosted mode

Point the adapter at your own `@photon-ai/advanced-imessage` gRPC server.

1. Set `IMESSAGE_SERVER_URL` to the server's gRPC address as `host:port` (e.g. `imessage.example.com:443`).
2. Set `IMESSAGE_API_KEY` to the server's auth token.
3. Set `IMESSAGE_LOCAL=false`.

> ⚠️ **Transport change.** Previous versions of this adapter spoke HTTP/Socket.IO. It now uses gRPC via spectrum-ts, so `IMESSAGE_SERVER_URL` must be a gRPC `host:port`, **not** an `https://` URL. A bare host gets `:443` appended; any URL scheme is stripped.

For advanced multi-number setups, pass explicit `clients` instead:

```typescript
createiMessageAdapter({
  local: false,
  clients: [
    { address: "imessage.example.com:443", token: "…", phone: "+1234567890" },
  ],
});
```

### Local mode

Local mode requires running directly on a macOS machine with iMessage. It uses Apple's native APIs — reading from the local `chat.db` and sending on-device — with no external server.

1. Grant **Full Disk Access** to your terminal or application in **System Settings → Privacy & Security → Full Disk Access**.
2. Ensure iMessage is signed in and working on the Mac.
3. No additional environment variables are required — local mode is the default.

## Receiving messages

There are two ways to receive inbound messages:

- **Webhooks** (recommended for serverless) — Spectrum Cloud delivers each message to an HTTPS endpoint as signed JSON. No long-lived connection or cron job. Remote (cloud) mode only.
- **Gateway listener** — `startGatewayListener()` consumes spectrum-ts's message stream in real time. Works in all modes; in serverless it needs a cron job to stay connected.

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

`bot.webhooks.imessage` calls the adapter's `handleWebhook`: it verifies the signature, parses the `messages` event, and routes the message into your bot. Processing runs in the background via `waitUntil`, so the endpoint acknowledges immediately. Spectrum Cloud retries failed deliveries with backoff and delivers at-least-once — dedupe on `X-Spectrum-Webhook-Id` + `message.id` if you need exactly-once side effects.

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
| `local` | No | `true` for local, `false` for cloud/self-host. Defaults to local unless `local: false`, `IMESSAGE_LOCAL=false`, or remote credentials (cloud/self-host) are provided |
| `projectId` | Cloud | Spectrum Cloud project ID. Auto-detected from `IMESSAGE_PROJECT_ID` |
| `projectSecret` | Cloud | Spectrum Cloud project secret. Auto-detected from `IMESSAGE_PROJECT_SECRET` |
| `serverUrl` | Self-host | gRPC `host:port` of your iMessage server. Auto-detected from `IMESSAGE_SERVER_URL` |
| `apiKey` | Self-host | Auth token for the self-hosted server. Auto-detected from `IMESSAGE_API_KEY` |
| `clients` | No | Explicit `{ address, token, phone }[]` for multi-number self-host setups |
| `phone` | No | Routing/identity phone for legacy self-host (defaults to `"shared"`). Auto-detected from `IMESSAGE_PHONE` |
| `webhookSecret` | No | Per-webhook signing secret for verifying Spectrum Cloud deliveries. Required to receive [webhooks](#webhooks). Auto-detected from `IMESSAGE_WEBHOOK_SECRET` |
| `logger` | No | Logger instance (defaults to `ConsoleLogger("info")`) |

## Environment variables

```bash
# .env.local
IMESSAGE_LOCAL=false                  # "false" for cloud/self-host (default: true)

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
| File uploads | Yes (send) |
| Reactions (add) | Remote only |
| Reactions (remove) | No |
| Message editing | Remote only |
| Typing indicator | Remote only |
| Modals | Limited (Remote only) |
| Message history | No |
| Thread/chat info | No |
| Cards | No |
| Streaming | No |
| Ephemeral messages | No |
| Webhooks | Yes (remote — Spectrum Cloud delivery) |

> **Remote** means cloud or self-hosted mode (anything other than `local: true`).

## Modals (Limited)

Remote mode supports limited modal functionality by mapping the Chat SDK's `openModal()` to iMessage native polls. Only `Select` children are supported — the first `Select` in the modal becomes a poll.

- `Modal.title` becomes the poll question.
- `Select.options` become the poll choices (2–10 supported).
- Votes trigger `onModalSubmit` with the selected option's `value`.

```typescript
import { Chat, Modal, Select, SelectOption } from "chat";
import { createiMessageAdapter } from "@photon-ai/chat-adapter-imessage";

const bot = new Chat({
  userName: "mybot",
  adapters: {
    imessage: createiMessageAdapter({ local: false }),
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

**Not supported:** `Select.placeholder`/`label`, `TextInput`, `RadioSelect`, `Modal.submitLabel`/`closeLabel`, more than one `Select`, and poll vote *deselection*. Polls in the same chat must have distinct titles (votes are matched back to the modal by title). Local mode throws `NotImplementedError`.

## Tapback reactions

iMessage uses tapbacks instead of emoji reactions. The adapter maps standard emoji names to iMessage tapbacks:

| Emoji name | Tapback |
|------------|---------|
| `love` / `heart` | Love |
| `like` / `thumbs_up` | Like |
| `dislike` / `thumbs_down` | Dislike |
| `laugh` | Laugh |
| `emphasize` / `exclamation` | Emphasize |
| `question` | Question |

## Limitations

- **Cold sends need a resolvable line.** The adapter rebuilds a thread — DM or group — from its chat GUID via spectrum-ts's `space.get`, so it can send, react, edit, and show typing even into a thread it hasn't seen this session, including a [webhook](#webhooks) delivery. With **multiple iMessage lines** configured, spectrum-ts cannot infer which line an unseen chat belongs to, so cold sends there throw `NotImplementedError` — respond within a received message's thread instead.
- **No message history.** `fetchMessages` is not supported — spectrum-ts exposes no paginated history API.
- **No thread/chat info.** `fetchThread` is not supported.
- **No reaction removal.** `removeReaction` is not supported.
- **Local mode** supports sending (including cold sends by chat GUID) and receiving, but not reactions, typing, editing, modals, history, or thread info.
- **Formatting.** iMessage is plain-text only; Markdown formatting is stripped when sending, preserving the text content.
- **Platform.** Local mode requires macOS. Cloud and self-host run anywhere.
- **Cards.** iMessage has no structured card layouts.

## Breaking changes

This version re-platforms the adapter onto **spectrum-ts**. If you are upgrading:

- **Dependency** — replaces `@photon-ai/imessage-kit` + `@photon-ai/advanced-imessage-kit` with `spectrum-ts`.
- **`IMESSAGE_SERVER_URL` is now a gRPC `host:port`** (self-host), not an `https://` / Socket.IO URL.
- **New cloud path** — set `IMESSAGE_PROJECT_ID` + `IMESSAGE_PROJECT_SECRET` for Spectrum Cloud.
- **Removed capabilities** (now `NotImplementedError`): `fetchMessages`, `fetchThread`, and `removeReaction`. Local `fetchMessages` (previously supported) is also removed. Cold `postMessage` works for DMs and groups alike (rebuilt from the chat GUID — see [Limitations](#limitations)).
- **`adapter.sdk` → `adapter.app`** — the adapter now exposes the underlying `SpectrumInstance` as `adapter.app` (null until `initialize()`).

## Troubleshooting

### "serverUrl is required when local is false"

- Provide cloud credentials (`IMESSAGE_PROJECT_ID` + `IMESSAGE_PROJECT_SECRET`), or a self-host `IMESSAGE_SERVER_URL` + `IMESSAGE_API_KEY`.

### Self-host connection issues

- Confirm `IMESSAGE_SERVER_URL` is a gRPC `host:port` (e.g. `imessage.example.com:443`), not an `https://` URL.
- Verify the token matches your server's credentials.

### Local mode not receiving messages

- Verify **Full Disk Access** is granted to your terminal or application.
- Check that iMessage is signed in and working.

### `NotImplementedError` from `fetchMessages` / `fetchThread` / `removeReaction`

- These are not supported by spectrum-ts. See [Limitations](#limitations).

## License

MIT
