import { attachment, type ContentBuilder } from "@spectrum-ts/core";
import type { FileUpload } from "chat";
import { lookup as lookupMimeType } from "mime-types";

/** Convert a Chat SDK file upload into a spectrum-ts attachment content builder. */
export async function fileToAttachment(
  file: FileUpload
): Promise<ContentBuilder> {
  const data = file.data;
  let buffer: Buffer;
  if (Buffer.isBuffer(data)) {
    buffer = data;
  } else if (data instanceof Blob) {
    buffer = Buffer.from(await data.arrayBuffer());
  } else {
    buffer = Buffer.from(data as ArrayBuffer);
  }

  const name = file.filename || "attachment";
  // Always resolve an explicit MIME type: spectrum's attachment() throws if it
  // can't infer one from `name` (no octet-stream fallback, and dotted-but-
  // unknown extensions still miss). Use the upload's type, else infer from the
  // extension, else a generic binary type.
  const mimeType =
    file.mimeType || lookupMimeType(name) || "application/octet-stream";

  return attachment(buffer, { name, mimeType });
}
