import { ID, ImageFormat, Permission, Role, Storage } from "appwrite";
import { APPWRITE_PROFILE_MEDIA_BUCKET_ID, storage } from "./client";

/**
 * Avatar pipeline (Phase 2).
 *
 * OWASP-aligned: extension allowlist, real file-type sniffing (magic bytes, not
 * the client-supplied Content-Type), size cap, generated filename, authenticated
 * upload only, and file-level security with owner update/delete.
 *
 * Raw uploads never go to the temporary Lens media bucket — avatars live in the
 * dedicated `profile_media` bucket.
 */

export const AVATAR_MAX_BYTES = 2_000_000;
const AVATAR_SIZE = 512;
const ALLOWED_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];

export interface AvatarValidation {
  ok: boolean;
  message?: string;
  detectedType?: "image/jpeg" | "image/png" | "image/webp";
}

function extensionOf(name: string): string {
  const parts = name.toLowerCase().split(".");
  return parts.length > 1 ? parts[parts.length - 1] : "";
}

/** Magic-byte sniffing so a renamed .exe cannot pose as an avatar. */
export async function sniffImageType(file: File): Promise<AvatarValidation> {
  if (extensionOf(file.name) && !ALLOWED_EXTENSIONS.includes(extensionOf(file.name))) {
    return { ok: false, message: "Use a JPG, PNG or WebP image." };
  }
  if (file.size > AVATAR_MAX_BYTES * 4) {
    return { ok: false, message: "That image is too large to process. Pick one under 8 MB." };
  }

  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const isJpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  const isWebp =
    head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
    head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50;

  if (isJpeg) return { ok: true, detectedType: "image/jpeg" };
  if (isPng) return { ok: true, detectedType: "image/png" };
  if (isWebp) return { ok: true, detectedType: "image/webp" };
  return { ok: false, message: "That file is not a readable JPG, PNG or WebP image." };
}

/** Center-crops to a square and re-encodes small, so uploads stay ~100 kB. */
export async function compressAvatar(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Your browser could not process this image.");
  context.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    AVATAR_SIZE,
    AVATAR_SIZE,
  );
  bitmap.close?.();

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.85));
  if (!blob) throw new Error("Your browser could not process this image.");
  if (blob.size > AVATAR_MAX_BYTES) throw new Error("That image is still too large after compression.");
  return new File([blob], `avatar-${Date.now()}.webp`, { type: "image/webp" });
}

export interface UploadAvatarResult {
  ok: boolean;
  fileId?: string;
  message?: string;
}

export async function uploadAvatar(userId: string, file: File): Promise<UploadAvatarResult> {
  if (!APPWRITE_PROFILE_MEDIA_BUCKET_ID) return { ok: false, message: "Avatar storage is not configured yet." };

  const validation = await sniffImageType(file);
  if (!validation.ok) return { ok: false, message: validation.message };

  let compressed: File;
  try {
    compressed = await compressAvatar(file);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not process that image." };
  }

  try {
    const created = await storage.createFile({
      bucketId: APPWRITE_PROFILE_MEDIA_BUCKET_ID,
      fileId: ID.unique(),
      file: compressed,
      // Readable by signed-in students (it is an opt-in social avatar), writable
      // only by its owner.
      permissions: [
        Permission.read(Role.users()),
        Permission.update(Role.user(userId)),
        Permission.delete(Role.user(userId)),
      ],
    });
    return { ok: true, fileId: created.$id };
  } catch (error) {
    return { ok: false, message: "We could not upload your photo. Please try again." };
  }
}

export async function deleteAvatar(fileId: string): Promise<void> {
  if (!APPWRITE_PROFILE_MEDIA_BUCKET_ID || !fileId) return;
  try {
    await storage.deleteFile({ bucketId: APPWRITE_PROFILE_MEDIA_BUCKET_ID, fileId });
  } catch {
    /* already gone — nothing to clean up */
  }
}

/** Small square preview URL for UI rendering. */
export function avatarPreviewUrl(fileId: string | null | undefined, size = 128): string | null {
  if (!fileId || !APPWRITE_PROFILE_MEDIA_BUCKET_ID) return null;
  return storage.getFilePreview({
    bucketId: APPWRITE_PROFILE_MEDIA_BUCKET_ID,
    fileId,
    width: size,
    height: size,
    quality: 80,
    output: ImageFormat.Webp,
  });
}

export function isStorageReady(): boolean {
  return Boolean(APPWRITE_PROFILE_MEDIA_BUCKET_ID) && storage instanceof Storage;
}
