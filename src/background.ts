import { ValidationError } from "@chat-adapter/shared";
import type { FileUpload } from "chat";
import { lookup as lookupMimeType } from "mime-types";
import type { ContentBuilder } from "@spectrum-ts/core";
import { background as backgroundContent } from "@spectrum-ts/imessage";

/**
 * Image bytes for a chat background. Accepts raw bytes (`Uint8Array` / `Buffer`
 * / `ArrayBuffer`), a `Blob`, or a Chat SDK `FileUpload` — whatever your image
 * pipeline hands back gets normalized to the bytes spectrum-ts expects.
 */
export type BackgroundBytes = Uint8Array | ArrayBuffer | Blob | FileUpload;

/**
 * A chat-background source. Either:
 *
 * - the literal `"clear"` sentinel, to remove the current background;
 * - in-memory {@link BackgroundBytes};
 * - an `http(s)` URL (a `URL` or a string) that spectrum-ts fetches at send
 *   time. Local file paths aren't accepted — read the file into bytes and pass
 *   those instead.
 */
export type BackgroundInput = "clear" | BackgroundBytes | URL | string;

/** Optional chat-background metadata. */
export interface BackgroundOptions {
  /**
   * MIME type of the image (`image/*`). Required for raw bytes when the `name`
   * carries no image extension; inferred from the URL / name otherwise.
   */
  mimeType?: string;
  /** File name used to infer the MIME type from its extension. */
  name?: string;
}

const IMAGE_MIME_PATTERN = /^image\//i;

/**
 * Normalize accepted byte inputs to a fresh `Buffer`, alongside any name / MIME
 * hints the input carries. The copy detaches the bytes from any pooled/shared
 * backing buffer (e.g. a Node `Buffer`), matching how attachment, voice, and
 * mini-app bytes are handled — spectrum-ts reads them lazily at send time.
 */
async function toBytes(input: BackgroundBytes): Promise<{
  bytes: Buffer;
  mimeHint?: string;
  nameHint?: string;
}> {
  if (input instanceof Uint8Array) {
    // Buffer is a Uint8Array subclass, so this also covers Node Buffers.
    return { bytes: Buffer.from(input) };
  }
  if (input instanceof ArrayBuffer) {
    return { bytes: Buffer.from(input) };
  }
  if (input instanceof Blob) {
    return {
      bytes: Buffer.from(await input.arrayBuffer()),
      mimeHint: input.type || undefined,
    };
  }
  // Otherwise treat it as a Chat SDK FileUpload and unwrap its `data`.
  const data = (input as FileUpload).data;
  if (data === undefined) {
    throw new ValidationError(
      "imessage",
      "Chat background must be a Uint8Array, ArrayBuffer, Blob, or FileUpload"
    );
  }
  const nested = await toBytes(data as BackgroundBytes);
  return {
    bytes: nested.bytes,
    mimeHint: (input as FileUpload).mimeType || nested.mimeHint,
    nameHint: (input as FileUpload).filename || nested.nameHint,
  };
}

/**
 * Resolve a URL source. A `URL` instance passes through; a string is parsed and
 * must be an `http(s)` URL. Returns `undefined` for byte inputs so the caller
 * falls through to the bytes path.
 */
function toBackgroundUrl(input: BackgroundInput): URL | undefined {
  if (input instanceof URL) {
    return input;
  }
  if (typeof input !== "string") {
    return;
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ValidationError(
      "imessage",
      `Chat background string input must be an http(s) URL, got "${input}". Pass image bytes for local files.`
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ValidationError(
      "imessage",
      `Chat background URL must be http(s), got "${url.protocol}"`
    );
  }
  return url;
}

/**
 * Resolve an `image/*` MIME type for a byte source from an explicit hint (the
 * caller's `mimeType`, or a Blob/FileUpload's own type) or by inference from
 * the name's extension. Throws a `ValidationError` when neither yields an image
 * type — spectrum-ts requires one to set the background from raw bytes.
 */
function resolveBytesMime(
  hint: string | undefined,
  name: string | undefined
): string {
  if (hint && IMAGE_MIME_PATTERN.test(hint)) {
    return hint;
  }
  if (name) {
    const inferred = lookupMimeType(name);
    if (inferred && IMAGE_MIME_PATTERN.test(inferred)) {
      return inferred;
    }
  }
  throw new ValidationError(
    "imessage",
    hint
      ? `Chat background requires an image/* MIME type, got "${hint}"`
      : 'Chat background requires an image/* MIME type — pass options.mimeType (e.g. "image/jpeg") or a name with an image extension'
  );
}

/**
 * Validate and normalize a chat-background source into the spectrum-ts
 * `background()` content builder. The `"clear"` sentinel removes the current
 * background; URL sources are fetched by spectrum-ts at send time; byte sources
 * are copied to a detached `Buffer` and tagged with a resolved `image/*` MIME
 * type. The builder is a fire-and-forget control signal — remote and
 * iMessage-only.
 */
export async function resolveBackground(
  input: BackgroundInput,
  options: BackgroundOptions = {}
): Promise<ContentBuilder> {
  if (input === "clear") {
    return backgroundContent("clear");
  }

  if (options.mimeType && !IMAGE_MIME_PATTERN.test(options.mimeType)) {
    throw new ValidationError(
      "imessage",
      `Chat background requires an image/* MIME type, got "${options.mimeType}"`
    );
  }

  const url = toBackgroundUrl(input);
  if (url) {
    // spectrum-ts fetches the URL at send time and infers the MIME type from
    // its path when we don't override it.
    return backgroundContent(
      url,
      options.mimeType ? { mimeType: options.mimeType } : undefined
    );
  }

  const { bytes, mimeHint, nameHint } = await toBytes(input as BackgroundBytes);
  const name = options.name ?? nameHint;
  const mimeType = resolveBytesMime(options.mimeType ?? mimeHint, name);
  return backgroundContent(bytes, { mimeType });
}
