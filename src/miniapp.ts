import { ValidationError } from "@chat-adapter/shared";
import type { FileUpload } from "chat";
import type { AppUrl } from "spectrum-ts";
import type { CustomizedMiniAppInput } from "spectrum-ts/providers/imessage";

export type { AppUrl } from "spectrum-ts";
export type { CustomizedMiniAppInput } from "spectrum-ts/providers/imessage";

/**
 * Image bytes for a mini-app card's inline image. Accepts raw bytes
 * (`Uint8Array` / `Buffer` / `ArrayBuffer`), a `Blob`, or a Chat SDK
 * `FileUpload` — whatever you already have on hand gets converted to the
 * `Uint8Array` spectrum-ts expects.
 */
export type MiniAppImage = Uint8Array | ArrayBuffer | Blob | FileUpload;

/**
 * Layout of a mini-app card — everything the recipient sees in the bubble.
 * Every field is optional; supply the ones that make sense for your card. The
 * `image` renders as the card's artwork, with `imageTitle` / `imageSubtitle`
 * overlaid; the caption fields fill the text rows, and `summary` is the
 * fallback text shown where the mini-app can't render.
 */
export interface MiniAppCardLayout {
  caption?: string;
  image?: MiniAppImage;
  imageSubtitle?: string;
  imageTitle?: string;
  subcaption?: string;
  summary?: string;
  trailingCaption?: string;
  trailingSubcaption?: string;
}

/**
 * A native iMessage mini-app card (an `MSMessageExtension` balloon). The
 * `appName`, `teamId`, and `extensionBundleId` identify the iMessage extension
 * that opens when the recipient taps the card, receiving `url`; `appStoreId`
 * optionally points recipients without the extension installed at its App
 * Store entry.
 */
export interface MiniAppCard {
  /** Display name of the iMessage extension. */
  appName: string;
  /** Optional App Store id, for recipients without the extension installed. */
  appStoreId?: number;
  /** Bundle id of the `MSMessageExtension` that receives the tap. */
  extensionBundleId: string;
  /** What the recipient sees in the bubble. */
  layout?: MiniAppCardLayout;
  /** Apple Developer team id that signs the extension. */
  teamId: string;
  /** URL handed to the extension when the card is tapped. */
  url: string | URL;
}

/**
 * Convert accepted image inputs to a fresh, `ArrayBuffer`-backed `Uint8Array`
 * — the exact shape spectrum-ts's schema expects. The copy also detaches the
 * bytes from any pooled/shared backing buffer (e.g. a Node `Buffer`).
 */
async function toImageBytes(
  image: MiniAppImage
): Promise<Uint8Array<ArrayBuffer>> {
  if (image instanceof Uint8Array) {
    // Buffer is a Uint8Array subclass, so this also covers Node Buffers.
    return new Uint8Array(image);
  }
  if (image instanceof ArrayBuffer) {
    return new Uint8Array(image);
  }
  if (image instanceof Blob) {
    return new Uint8Array(await image.arrayBuffer());
  }
  // Otherwise treat it as a Chat SDK FileUpload and unwrap its `data`.
  const data = (image as FileUpload).data;
  if (data === undefined) {
    throw new ValidationError(
      "imessage",
      "Mini-app card image must be a Uint8Array, ArrayBuffer, Blob, or FileUpload"
    );
  }
  return toImageBytes(data as MiniAppImage);
}

function requireField(value: string, field: string): string {
  if (!value || value.trim().length === 0) {
    throw new ValidationError(
      "imessage",
      `Mini-app card requires a non-empty "${field}"`
    );
  }
  return value;
}

/**
 * Validate and normalize a {@link MiniAppCard} into the
 * {@link CustomizedMiniAppInput} spectrum-ts's `customizedMiniApp()` builder
 * expects: required identifiers are checked non-empty, `url` is normalized to a
 * validated string, and the layout image (if any) is decoded to bytes.
 */
export async function resolveMiniApp(
  card: MiniAppCard
): Promise<CustomizedMiniAppInput> {
  const url = typeof card.url === "string" ? card.url : card.url.toString();
  try {
    // Surface a clear error here rather than deep inside the builder's schema.
    new URL(url);
  } catch {
    throw new ValidationError(
      "imessage",
      `Mini-app card has an invalid url: "${url}"`
    );
  }

  const layout = card.layout ?? {};
  const image = layout.image ? await toImageBytes(layout.image) : undefined;

  return {
    appName: requireField(card.appName, "appName"),
    teamId: requireField(card.teamId, "teamId"),
    extensionBundleId: requireField(
      card.extensionBundleId,
      "extensionBundleId"
    ),
    url,
    ...(card.appStoreId === undefined ? {} : { appStoreId: card.appStoreId }),
    layout: {
      caption: layout.caption,
      subcaption: layout.subcaption,
      trailingCaption: layout.trailingCaption,
      trailingSubcaption: layout.trailingSubcaption,
      imageTitle: layout.imageTitle,
      imageSubtitle: layout.imageSubtitle,
      summary: layout.summary,
      ...(image ? { image } : {}),
    },
  };
}

/**
 * Distinguish the lightweight `app(url)` form from a fully-specified
 * {@link MiniAppCard}. An {@link AppUrl} is a string, a `Promise<string>`, or a
 * thunk (`() => string | Promise<string>`) — the mini-app card is a plain
 * object with named fields, so it never matches any of those shapes.
 */
export function isAppUrl(input: MiniAppCard | AppUrl): input is AppUrl {
  return (
    typeof input === "string" ||
    typeof input === "function" ||
    (typeof input === "object" &&
      input !== null &&
      typeof (input as PromiseLike<string>).then === "function")
  );
}
