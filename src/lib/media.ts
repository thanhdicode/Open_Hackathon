/**
 * Media preparation for AI routes.
 *
 * A phone photo is routinely 3-12 MB, which blows the latency budget and sends
 * far more pixels than the model needs to read signage. Media is therefore
 * downscaled and re-encoded in the browser before it is sent.
 *
 * Privacy: raw media is held in memory for the request only. Nothing here
 * writes to storage or to localStorage, and the caller revokes object URLs.
 */

export const MEDIA_LIMITS = {
  imageBytes: 8 * 1024 * 1024,
  audioBytes: 12 * 1024 * 1024,
  documentBytes: 12 * 1024 * 1024,
  /** Longest edge after downscaling. Enough for signage and slide text. */
  maxEdge: 1600,
} as const;

export type MediaKind = "image" | "audio" | "document";

export interface PreparedMedia {
  base64: string;
  mimeType: string;
  /** Original file name for display only; never sent to the provider. */
  name: string;
  width?: number;
  height?: number;
  originalBytes: number;
  sentBytes: number;
}

export class MediaError extends Error {
  code: "INVALID_FILE" | "UNSUPPORTED_MEDIA" | "FILE_TOO_LARGE" | "DECODE_FAILED";
  constructor(code: MediaError["code"], message: string) {
    super(message);
    this.name = "MediaError";
    this.code = code;
  }
}

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"];
const AUDIO_TYPES = ["audio/webm", "audio/mp4", "audio/mpeg", "audio/wav", "audio/ogg", "audio/x-m4a"];
const DOCUMENT_TYPES = [...IMAGE_TYPES, "application/pdf"];

export function mediaKindOf(mimeType: string): MediaKind | null {
  if (IMAGE_TYPES.includes(mimeType)) return "image";
  if (AUDIO_TYPES.includes(mimeType)) return "audio";
  if (mimeType === "application/pdf") return "document";
  return null;
}

export function bytesOf(file: Blob): number {
  return file.size;
}

function assertSize(bytes: number, kind: MediaKind, name: string) {
  const limit = kind === "image" ? MEDIA_LIMITS.imageBytes : kind === "audio" ? MEDIA_LIMITS.audioBytes : MEDIA_LIMITS.documentBytes;
  if (bytes > limit) {
    throw new MediaError("FILE_TOO_LARGE", `${name} is ${(bytes / 1024 / 1024).toFixed(1)} MB. The limit is ${Math.round(limit / 1024 / 1024)} MB.`);
  }
}

function base64Of(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

async function decodeImage(file: File): Promise<{ bitmap: ImageBitmap | HTMLImageElement; width: number; height: number; cleanup: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return { bitmap, width: bitmap.width, height: bitmap.height, cleanup: () => bitmap.close() };
    } catch {
      /* fall through to the <img> path for formats createImageBitmap rejects */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new MediaError("DECODE_FAILED", "That image could not be read."));
      element.src = url;
    });
    return { bitmap: image, width: image.naturalWidth, height: image.naturalHeight, cleanup: () => URL.revokeObjectURL(url) };
  } catch (cause) {
    URL.revokeObjectURL(url);
    throw cause;
  }
}

/**
 * Downscale an image so its longest edge is at most `maxEdge` and re-encode it.
 * Images already within budget are passed through untouched so no quality is
 * lost when it is not necessary.
 */
export async function prepareImage(file: File, { maxEdge = MEDIA_LIMITS.maxEdge } = {}): Promise<PreparedMedia> {
  const kind = mediaKindOf(file.type);
  if (kind !== "image") throw new MediaError("UNSUPPORTED_MEDIA", `${file.type || "That file"} is not a supported image type.`);
  assertSize(file.size, "image", file.name);

  const longestEdge = Math.max(1, await longestEdgeOf(file));
  if (longestEdge <= maxEdge) {
    const buffer = await file.arrayBuffer();
    return { base64: base64Of(buffer), mimeType: file.type, name: file.name, originalBytes: file.size, sentBytes: file.size };
  }

  const decoded = await decodeImage(file);
  try {
    const scale = maxEdge / Math.max(decoded.width, decoded.height);
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new MediaError("DECODE_FAILED", "This browser could not prepare the image.");
    context.drawImage(decoded.bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    if (!blob) throw new MediaError("DECODE_FAILED", "This browser could not prepare the image.");
    const buffer = await blob.arrayBuffer();
    return {
      base64: base64Of(buffer),
      mimeType: "image/jpeg",
      name: file.name,
      width,
      height,
      originalBytes: file.size,
      sentBytes: blob.size,
    };
  } finally {
    decoded.cleanup();
  }
}

async function longestEdgeOf(file: File): Promise<number> {
  const decoded = await decodeImage(file);
  try {
    return Math.max(decoded.width, decoded.height);
  } finally {
    decoded.cleanup();
  }
}

export async function prepareAudio(file: File): Promise<PreparedMedia> {
  const kind = mediaKindOf(file.type);
  if (kind !== "audio") throw new MediaError("UNSUPPORTED_MEDIA", `${file.type || "That file"} is not a supported audio type.`);
  assertSize(file.size, "audio", file.name);
  const buffer = await file.arrayBuffer();
  return { base64: base64Of(buffer), mimeType: file.type, name: file.name, originalBytes: file.size, sentBytes: file.size };
}

export async function prepareDocument(file: File): Promise<PreparedMedia> {
  const kind = mediaKindOf(file.type);
  if (kind === "image") return prepareImage(file);
  if (file.type === "application/pdf") {
    assertSize(file.size, "document", file.name);
    const buffer = await file.arrayBuffer();
    return { base64: base64Of(buffer), mimeType: file.type, name: file.name, originalBytes: file.size, sentBytes: file.size };
  }
  throw new MediaError("UNSUPPORTED_MEDIA", `${file.type || "That file"} is not supported. Use an image or a PDF.`);
}

/** Image dimensions without full preparation, for the overlay renderer. */
export async function imageDimensions(file: File): Promise<{ width: number; height: number }> {
  const decoded = await decodeImage(file);
  try {
    return { width: decoded.width, height: decoded.height };
  } finally {
    decoded.cleanup();
  }
}
