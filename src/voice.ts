import { ValidationError } from "@chat-adapter/shared";
import type { FileUpload } from "chat";
import { lookup as lookupMimeType } from "mime-types";
import { type ContentBuilder, voice as voiceContent } from "@spectrum-ts/core";

/**
 * Audio bytes for a voice message. Accepts raw bytes (`Uint8Array` / `Buffer` /
 * `ArrayBuffer`), a `Blob`, or a Chat SDK `FileUpload` — whatever your TTS
 * pipeline hands back gets normalized to the bytes spectrum-ts expects.
 */
export type VoiceBytes = Uint8Array | ArrayBuffer | Blob | FileUpload;

/**
 * A voice message source: in-memory {@link VoiceBytes}, or an `http(s)` URL (a
 * `URL` or a string) that spectrum-ts fetches at send time. Local file paths
 * aren't accepted — read the file into bytes and pass those instead.
 */
export type VoiceInput = VoiceBytes | URL | string;

/** Optional voice-message metadata. */
export interface VoiceOptions {
  /**
   * Playback duration in seconds, surfaced on the waveform bubble. Optional —
   * iMessage derives the waveform from the audio itself when omitted.
   */
  duration?: number;
  /**
   * MIME type of the audio (`audio/*`). Required for raw bytes when the `name`
   * carries no audio extension; inferred from the URL / name otherwise.
   */
  mimeType?: string;
  /** File name handed to spectrum-ts (also used to infer the MIME type). */
  name?: string;
}

const AUDIO_MIME_PATTERN = /^audio\//i;

/**
 * Normalize accepted byte inputs to a fresh `Buffer`, alongside any name / MIME
 * hints the input carries. The copy detaches the bytes from any pooled/shared
 * backing buffer (e.g. a Node `Buffer`), matching how attachment and mini-app
 * bytes are handled — spectrum-ts reads them lazily at send time.
 */
async function toBytes(input: VoiceBytes): Promise<{
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
      "Voice message must be a Uint8Array, ArrayBuffer, Blob, or FileUpload"
    );
  }
  const nested = await toBytes(data as VoiceBytes);
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
function toVoiceUrl(input: VoiceInput): URL | undefined {
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
      `Voice message string input must be an http(s) URL, got "${input}". Pass audio bytes for local files.`
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ValidationError(
      "imessage",
      `Voice message URL must be http(s), got "${url.protocol}"`
    );
  }
  return url;
}

/**
 * Resolve an `audio/*` MIME type for a byte source from an explicit hint (the
 * caller's `mimeType`, or a Blob/FileUpload's own type) or by inference from
 * the name's extension. Throws a `ValidationError` when neither yields an audio
 * type — spectrum-ts requires one to render a playable voice note.
 */
function resolveBytesMime(
  hint: string | undefined,
  name: string | undefined
): string {
  if (hint && AUDIO_MIME_PATTERN.test(hint)) {
    return hint;
  }
  if (name) {
    const inferred = lookupMimeType(name);
    if (inferred && AUDIO_MIME_PATTERN.test(inferred)) {
      return inferred;
    }
  }
  throw new ValidationError(
    "imessage",
    hint
      ? `Voice message requires an audio/* MIME type, got "${hint}"`
      : 'Voice message requires an audio/* MIME type — pass options.mimeType (e.g. "audio/mp4") or a name with an audio extension'
  );
}

/**
 * Validate and normalize a voice source into the spectrum-ts `voice()` content
 * builder. URL sources are fetched by spectrum-ts at send time; byte sources
 * are copied to a detached `Buffer` and tagged with a resolved `audio/*` MIME
 * type. The builder is sent as a native iMessage voice note (a waveform
 * bubble), not an audio-file attachment.
 */
export async function resolveVoice(
  input: VoiceInput,
  options: VoiceOptions = {}
): Promise<ContentBuilder> {
  if (options.mimeType && !AUDIO_MIME_PATTERN.test(options.mimeType)) {
    throw new ValidationError(
      "imessage",
      `Voice message requires an audio/* MIME type, got "${options.mimeType}"`
    );
  }

  const url = toVoiceUrl(input);
  if (url) {
    // spectrum-ts fetches the URL at send time and infers the MIME type from
    // its path when we don't override it.
    return voiceContent(url, {
      ...(options.mimeType ? { mimeType: options.mimeType } : {}),
      ...(options.name ? { name: options.name } : {}),
      ...(options.duration === undefined ? {} : { duration: options.duration }),
    });
  }

  const { bytes, mimeHint, nameHint } = await toBytes(input as VoiceBytes);
  const name = options.name ?? nameHint;
  const mimeType = resolveBytesMime(options.mimeType ?? mimeHint, name);
  return voiceContent(bytes, {
    mimeType,
    ...(name ? { name } : {}),
    ...(options.duration === undefined ? {} : { duration: options.duration }),
  });
}
