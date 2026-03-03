# chat-adapter-imessage

iMessage community adapter for [Chat SDK](https://chat-sdk.dev/docs). Supports both local (on-device) and remote ([Photon](https://photon.codes)-based) iMessage integration.

## Installation

```bash
pnpm add chat chat-adapter-imessage
```

## Usage

The adapter supports two modes: **local** (running directly on a Mac with iMessage) and **remote** (connecting to a [Photon](https://photon.codes) iMessage server). The mode is auto-detected from the `IMESSAGE_LOCAL` environment variable.

### Remote mode

Recommended for production. Connects to [Photon](https://photon.codes)'s managed iMessage service over HTTP and Socket.IO, so your bot can run on any platform.

```typescript
import { Chat } from "chat";
import { createiMessageAdapter } from "chat-adapter-imessage";

const bot = new Chat({
  userName: "mybot",
  adapters: {
    imessage: createiMessageAdapter({
      local: false,
    }),
  },
});

bot.onNewMention(async (thread, message) => {
  await thread.post("Hello from iMessage!");
});
```

### Local mode

For development or self-hosted deployments using [imessage-kit](https://github.com/photon-hq/imessage-kit). Reads from the local iMessage database and sends via AppleScript. Must run on macOS with **Full Disk Access** granted.

```typescript
import { Chat } from "chat";
import { createiMessageAdapter } from "chat-adapter-imessage";

const bot = new Chat({
  userName: "mybot",
  adapters: {
    imessage: createiMessageAdapter({
      local: true,
    }),
  },
});

bot.onNewMention(async (thread, message) => {
  await thread.post("Hello from iMessage!");
});
```

## Setup

### Remote mode

Remote mode connects to a [Photon](https://photon.codes) iMessage server, which handles the macOS-side integration on your behalf. You'll need an active Photon subscription to get your server credentials.

1. [Request access](https://photon.codes) from Photon to get your server credentials
2. Copy your **server URL** and **API key** from the Photon dashboard
3. Set `IMESSAGE_SERVER_URL` and `IMESSAGE_API_KEY` environment variables
4. Set `IMESSAGE_LOCAL=false`

### Local mode

Local mode requires the adapter to run directly on a macOS machine with iMessage. It uses Apple's native APIs — reading from the local `chat.db` database and sending messages via AppleScript — with no external server required.

1. Grant **Full Disk Access** to your terminal or application in **System Settings > Privacy & Security > Full Disk Access**
2. Ensure iMessage is signed in and working on the Mac
3. No additional environment variables are required — local mode is the default

## Receiving messages

Call `startGatewayListener()` to listen for new messages in real-time. In remote mode, this uses Socket.IO push events. In local mode, it polls the iMessage database.

In serverless environments, use a cron job to maintain the connection.

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
| `local` | No | `true` for local mode, `false` for remote. Auto-detected from `IMESSAGE_LOCAL` (default: `true`) |
| `serverUrl` | Remote only | URL of the remote iMessage server. Auto-detected from `IMESSAGE_SERVER_URL` |
| `apiKey` | Remote only | API key for remote server authentication. Auto-detected from `IMESSAGE_API_KEY` |
| `logger` | No | Logger instance (defaults to `ConsoleLogger("info")`) |

## Environment variables

```bash
# .env.local
IMESSAGE_LOCAL=false                 # Set to "false" for remote mode (default: true)
IMESSAGE_SERVER_URL=https://...       # Required for remote mode
IMESSAGE_API_KEY=...                 # Required for remote mode
```

## Features

| Feature | Supported |
|---------|-----------|
| Mentions | DMs only |
| Reactions (add/remove) | Remote only |
| Modals | Limited (Remote only) |
| Cards | No |
| Streaming | No |
| DMs | Yes |
| Ephemeral messages | No |
| File uploads | Yes |
| Typing indicator | Remote only |
| Message history | Yes |
| Message editing | Remote only |

## Modals (Limited)

Remote mode supports limited modal functionality by mapping the Chat SDK's `openModal()` to iMessage native polls via the Photon SDK. Only `Select` children are supported — the first `Select` in the modal is used to create a poll.

- `Modal.title` becomes the poll question
- `Select.options` become the poll choices
- Votes trigger `onModalSubmit` with the selected option's `value`

```typescript
import { Chat, Modal, Select, SelectOption } from "chat";
import { createiMessageAdapter } from "chat-adapter-imessage";

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
  const color = event.values.color;
  // color will be "red", "blue", or "green"
});
```

**Not supported:**

- `Select.placeholder` and `Select.label` — iMessage polls don't have these fields
- `TextInput`, `RadioSelect`, and other modal children — silently ignored
- `Modal.submitLabel` and `Modal.closeLabel` — not applicable to polls
- Only the **first** `Select` child is used; other children are ignored
- Local mode — `openModal()` throws `NotImplementedError`

## Tapback reactions

iMessage uses tapbacks instead of emoji reactions. The adapter maps standard emoji names to iMessage tapbacks:

| Emoji | Tapback |
|-------|---------|
| `love` / `heart` | Love |
| `like` / `thumbs_up` | Like |
| `dislike` / `thumbs_down` | Dislike |
| `laugh` | Laugh |
| `emphasize` / `exclamation` | Emphasize |
| `question` | Question |

## Limitations

- **Local mode**: Only supports sending/receiving messages, message history, and file uploads. Reactions, typing indicators, message editing, modals, and thread fetching require remote mode.
- **Formatting**: iMessage is plain-text only. Markdown formatting (bold, italic, etc.) is stripped when sending messages, preserving only the text content.
- **Platform**: Local mode requires macOS. Remote mode can run on any platform — [Photon](https://photon.codes) manages the iMessage infrastructure for you.
- **Cards**: iMessage has no support for structured card layouts.
- **Modals**: Limited to `Select`-based modals mapped to iMessage native polls. Only the first `Select` child is used; `placeholder`, `label`, `TextInput`, `RadioSelect`, and other fields are not supported. Remote mode only.

## Troubleshooting

### "serverUrl is required" error

- Set `IMESSAGE_SERVER_URL` or pass `serverUrl` in config when using remote mode
- This error occurs when `IMESSAGE_LOCAL=false` but no server URL is provided

### "apiKey is required" error

- Set `IMESSAGE_API_KEY` or pass `apiKey` in config when using remote mode

### Local mode not receiving messages

- Verify **Full Disk Access** is granted to your terminal or application
- Check that iMessage is signed in and working
- Messages are polled from the local database — there may be a short delay

### Remote mode connection issues

- Verify the server URL is correct and accessible
- Check that the API key matches your Photon iMessage service credentials
- Confirm your Photon subscription is active

## AI Agent Skill

An agent skill for this adapter is available in the [photon-hq/skills](https://github.com/photon-hq/skills ) repository. It provides a comprehensive, source-accurate reference that enables AI coding assistants (Cursor, Claude Code, Copilot, and others) to build with this adapter without needing to read the source.

```bash
npx skills add photon-hq/skills --skill vercel-chat-adapter
```

The skill covers setup, both local and remote modes, all adapter methods, type definitions, webhook payload shapes, and common pitfalls.

## License

MIT
