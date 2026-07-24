/**
 * Multimodal attachment handling (req #1 & #7).
 *
 * Supports file, image, video, and audio. Attachments are reference-first: we
 * carry an address ({@link MediaRef}) plus a summary between tool calls and only
 * read the bytes (`loadContent`) when a step actually needs them — so large media
 * isn't shipped on every call.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { Attachment, AttachmentType, MediaRef, UserContent } from "../types.js";

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
};

export function guessMimeType(file: string): string {
  return MIME_BY_EXT[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

export function attachmentTypeFor(mimeType: string): AttachmentType {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType === "application/pdf" || mimeType.startsWith("text/")) return "document";
  return "file";
}

/** Build a reference-only Attachment from a file path (no bytes read). */
export async function attachmentFromPath(file: string, summary?: string): Promise<Attachment> {
  const abs = path.resolve(file);
  const stat = await fs.stat(abs);
  const mimeType = guessMimeType(abs);
  const id = createHash("sha1").update(abs).digest("hex").slice(0, 12);
  const ref: MediaRef = { id, uri: abs, mimeType, size: stat.size, summary };
  return {
    id,
    type: attachmentTypeFor(mimeType),
    fileName: path.basename(abs),
    mimeType,
    size: stat.size,
    ref,
  };
}

/** Load the bytes for an attachment on demand and populate `content` (base64). */
export async function loadContent(att: Attachment): Promise<Attachment> {
  if (att.content) return att;
  const uri = att.ref?.uri;
  if (!uri) return att;
  const bytes = await fs.readFile(uri);
  return { ...att, content: bytes.toString("base64") };
}

/**
 * Convert an attachment to a user content block.
 * @param inline when true, ensures bytes are loaded and inlined; when false, keeps
 *        it as an address-only reference (the default, to stay lightweight).
 */
export async function attachmentToContent(att: Attachment, inline = false): Promise<UserContent> {
  const mimeType = att.mimeType;
  if (att.type === "image") {
    const loaded = inline ? await loadContent(att) : att;
    if (loaded.content) return { type: "image", data: loaded.content, mimeType };
    return { type: "file", uri: att.ref?.uri, mimeType };
  }
  if (att.type === "audio") {
    const loaded = inline ? await loadContent(att) : att;
    return { type: "audio", data: loaded.content, uri: att.ref?.uri, mimeType };
  }
  if (att.type === "video") {
    return { type: "video", uri: att.ref?.uri, data: inline ? (await loadContent(att)).content : undefined, mimeType };
  }
  // document / file
  if (att.extractedText) return { type: "text", text: att.extractedText };
  return { type: "file", uri: att.ref?.uri, mimeType };
}

/** Turn a user prompt + attachments into user content, references kept lazy. */
export async function buildUserContent(
  text: string,
  attachments?: Attachment[],
  inline = false,
): Promise<UserContent[]> {
  const content: UserContent[] = [{ type: "text", text }];
  for (const att of attachments ?? []) content.push(await attachmentToContent(att, inline));
  return content;
}

/** Extract just the references (address + summary) from attachments. */
export function refsFromAttachments(attachments?: Attachment[]): MediaRef[] {
  const refs: MediaRef[] = [];
  for (const a of attachments ?? []) {
    if (a.ref) refs.push(a.ref);
    else refs.push({ id: a.id, uri: a.fileName, mimeType: a.mimeType, size: a.size, summary: a.preview });
  }
  return refs;
}
