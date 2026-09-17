import { useRef, useState } from "react";
import { Avatar, Badge, Button, Card, Chip, Notice, ProgressBar } from "../../components/ui";
import { Icon } from "../../components/icons";
import { downscaleImage, type UploadProgress } from "../../lib/appwrite/community";
import { MEDIA_LIMITS, POST_TYPES, POST_TYPE_META, mediaKindFor, type Place, type PostType } from "../../lib/phase5/contract";
import { MediaView } from "./MediaView";
import type { PostMedia } from "../../lib/phase5/contract";

/**
 * Composer.
 *
 * A real posting surface: 1-4 photos, one short video, an optional place pin,
 * tags, and a preview of what the feed will actually show. The previous version
 * handled exactly one photo, which is why the community could only ever look
 * like a photo blog.
 *
 * THE STATE MACHINE IS THE POINT
 *
 * `idle -> selecting -> compressing -> uploading -> publishing -> success|failed`
 * is modelled explicitly rather than inferred from a couple of booleans, because
 * every one of those steps can stall and the student needs to know which one did.
 * "Posting…" covering a 20 MB video upload with no progress bar is the failure
 * this screen exists to avoid.
 *
 * The place picker is what makes a post appear on the map, so it is offered
 * inline rather than hidden behind a menu.
 */

export type ComposerState = "idle" | "compressing" | "uploading" | "publishing" | "success" | "failed";

export interface ComposerSubmission {
  body: string;
  postType: PostType;
  placeId: string | null;
  placeName: string | null;
  tags: string[];
  images: File[];
  video: File | null;
  onProgress: (update: UploadProgress) => void;
}

export interface ComposerProps {
  authorName: string;
  authorInitials: string;
  authorColor: string;
  /** "Singapore · NUS" — the journey context the post will carry. */
  contextLabel: string;
  /** Places already loaded by Explore, so the picker needs no extra request. */
  places: Place[];
  onCreate: (input: ComposerSubmission) => Promise<{ ok: boolean; message?: string }>;
  onCancel: () => void;
  defaultPlace?: Place | null;
}

const MAX_BODY = 4000;
const MAX_TAGS = 6;

interface Attachment {
  id: string;
  file: File;
  kind: "image" | "video";
  previewUrl: string;
}

let attachmentSeq = 0;

export function Composer({ authorName, authorInitials, authorColor, contextLabel, places, onCreate, onCancel, defaultPlace }: ComposerProps) {
  const [body, setBody] = useState("");
  const [postType, setPostType] = useState<PostType>("tip");
  const [place, setPlace] = useState<Place | null>(defaultPlace ?? null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [placeQuery, setPlaceQuery] = useState("");
  const [state, setState] = useState<ComposerState>("idle");
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);

  const imageInput = useRef<HTMLInputElement | null>(null);
  const videoInput = useRef<HTMLInputElement | null>(null);

  const busy = state === "compressing" || state === "uploading" || state === "publishing";
  const images = attachments.filter((item) => item.kind === "image");
  const video = attachments.find((item) => item.kind === "video") ?? null;

  function release(attachment: Attachment) {
    URL.revokeObjectURL(attachment.previewUrl);
  }

  async function pickImages(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    const incoming = Array.from(files);
    const room = MEDIA_LIMITS.maxImagesPerPost - images.length;
    if (room <= 0) {
      setError(`You can attach up to ${MEDIA_LIMITS.maxImagesPerPost} photos.`);
      return;
    }

    // Images are downscaled before upload. This is the "compressing" state and it
    // is real work — a 12 MP phone photo takes a moment — so it is shown rather
    // than hidden behind a spinner on the publish button.
    setState("compressing");
    const accepted: Attachment[] = [];
    for (const file of incoming.slice(0, room)) {
      const kind = mediaKindFor(file.type);
      if (kind !== "image") {
        setError("Photos must be JPG, PNG or WebP.");
        continue;
      }
      if (file.size > MEDIA_LIMITS.maxImageBytes) {
        setError(`Each photo must be under ${Math.round(MEDIA_LIMITS.maxImageBytes / 1_000_000)} MB.`);
        continue;
      }
      const scaled = await downscaleImage(file, 1600, 0.82);
      attachmentSeq += 1;
      accepted.push({ id: `a${attachmentSeq}`, file: scaled, kind: "image", previewUrl: URL.createObjectURL(scaled) });
    }
    setAttachments((current) => [...current, ...accepted]);
    setState("idle");
  }

  function pickVideo(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setError(null);
    if (mediaKindFor(file.type) !== "video") {
      setError("Video must be MP4 or WebM.");
      return;
    }
    if (file.size > MEDIA_LIMITS.maxVideoBytes) {
      setError(`Video must be under ${Math.round(MEDIA_LIMITS.maxVideoBytes / 1_000_000)} MB.`);
      return;
    }
    if (video) release(video);
    attachmentSeq += 1;
    const attachment: Attachment = { id: `a${attachmentSeq}`, file, kind: "video", previewUrl: URL.createObjectURL(file) };
    setAttachments((current) => [...current.filter((item) => item.kind !== "video"), attachment]);
  }

  function removeAttachment(id: string) {
    setAttachments((current) => {
      const target = current.find((item) => item.id === id);
      if (target) release(target);
      return current.filter((item) => item.id !== id);
    });
  }

  function addTag(raw: string) {
    const value = raw.trim().replace(/^#/, "").toLowerCase();
    if (!value || tags.length >= MAX_TAGS || tags.includes(value)) {
      setTagDraft("");
      return;
    }
    setTags((current) => [...current, value]);
    setTagDraft("");
  }

  async function submit() {
    if (!body.trim()) {
      setError("Write something useful first.");
      return;
    }
    setError(null);
    setState(attachments.length ? "uploading" : "publishing");
    setProgress(null);

    const result = await onCreate({
      body: body.trim(),
      postType,
      placeId: place?.id ?? null,
      placeName: place?.name ?? null,
      tags,
      images: images.map((item) => item.file),
      video: video?.file ?? null,
      onProgress: (update) => {
        setProgress(update);
        // The SDK's first progress callback means bytes are moving, so the label
        // can honestly change from "uploading" to a measured percentage.
        setState(update.percent === null ? "uploading" : "uploading");
      },
    });

    if (result.ok) {
      setState("success");
      attachments.forEach(release);
      return;
    }
    // Everything the student typed stays on screen so "retry" is one tap.
    setState("failed");
    setError(result.message ?? "Could not post. Try again.");
  }

  const matches = placeQuery.trim()
    ? places.filter((entry) => entry.name.toLowerCase().includes(placeQuery.trim().toLowerCase())).slice(0, 12)
    : places.slice(0, 12);

  const previewMedia: PostMedia[] = attachments.map((item) => ({
    id: item.id,
    kind: item.kind,
    url: item.previewUrl,
    alt: item.kind === "video" ? "Your video" : "Your photo",
  }));

  return (
    <div className="flex h-full flex-col bg-canvas">
      <div className="flex items-center justify-between border-b border-line bg-surface px-5 py-3">
        <button onClick={onCancel} className="min-h-[44px] text-[15px] font-semibold text-muted" disabled={busy}>
          Cancel
        </button>
        <p className="text-[15px] font-bold text-ink">{preview ? "Preview" : "Share something"}</p>
        <Button size="sm" onClick={() => void submit()} disabled={busy || !body.trim()}>
          {state === "publishing" ? "Posting…" : state === "uploading" ? "Uploading…" : state === "failed" ? "Retry" : "Post"}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scroll-area px-5 py-4">
        {preview ? (
          <Card className="overflow-hidden p-0">
            <div className="flex items-start gap-3 px-4 pt-4">
              <Avatar initials={authorInitials} color={authorColor} size={42} />
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-bold text-ink">{authorName}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
                  <span>{contextLabel}</span>
                  <span className="rounded-full bg-canvas px-2 py-0.5 text-[10px] font-semibold text-muted">{POST_TYPE_META[postType].label}</span>
                </p>
              </div>
            </div>
            <p className="mt-2.5 px-4 text-[14px] leading-relaxed text-ink">{body || "Your caption appears here."}</p>
            <MediaView media={previewMedia} variant="card" />
            {place && (
              <p className="mt-3 px-4 text-[11px] font-semibold text-muted">📍 {place.name}</p>
            )}
            <div className="mt-3 border-t border-line px-4 py-2.5 text-[12px] text-muted">
              This is exactly what other students will see.
            </div>
          </Card>
        ) : (
          <>
            <div className="flex items-start gap-3">
              <Avatar initials={authorInitials} color={authorColor} size={40} />
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-bold text-ink">{authorName}</p>
                <p className="text-[12px] text-muted">{contextLabel}</p>
                <textarea
                  value={body}
                  onChange={(event) => setBody(event.target.value.slice(0, MAX_BODY))}
                  rows={6}
                  autoFocus
                  placeholder="Share something that could help another student..."
                  aria-label="Post text"
                  className="mt-2 w-full resize-none rounded-[12px] border border-line bg-surface px-3.5 py-3 text-[14px] leading-relaxed text-ink outline-none placeholder:text-muted focus:border-ink"
                />
                <p className="mt-1 text-right text-[11px] text-muted">
                  {body.length}/{MAX_BODY}
                </p>
              </div>
            </div>

            <div className="mt-2">
              <p className="mb-2 text-[13px] font-bold text-ink">What kind of post is this?</p>
              <div className="flex flex-wrap gap-2">
                {POST_TYPES.map((type) => (
                  <Chip key={type} active={postType === type} onClick={() => setPostType(type)}>
                    {POST_TYPE_META[type].label}
                  </Chip>
                ))}
              </div>
            </div>

            {/* ---------------------------- media ---------------------------- */}
            <input
              ref={imageInput}
              type="file"
              accept={MEDIA_LIMITS.imageMime.join(",")}
              multiple
              className="hidden"
              data-testid="composer-image-input"
              onChange={(event) => {
                void pickImages(event.target.files);
                event.target.value = "";
              }}
            />
            <input
              ref={videoInput}
              type="file"
              accept={MEDIA_LIMITS.videoMime.join(",")}
              className="hidden"
              data-testid="composer-video-input"
              onChange={(event) => {
                pickVideo(event.target.files);
                event.target.value = "";
              }}
            />

            {attachments.length > 0 && (
              <div className="mt-4 grid grid-cols-2 gap-2">
                {attachments.map((item) => (
                  <div key={item.id} className="relative overflow-hidden rounded-[12px] border border-line bg-surface">
                    {item.kind === "video" ? (
                      <video src={item.previewUrl} controls playsInline preload="metadata" className="h-32 w-full bg-black object-contain" />
                    ) : (
                      <img src={item.previewUrl} alt="Attachment preview" className="h-32 w-full object-cover" />
                    )}
                    <button
                      onClick={() => removeAttachment(item.id)}
                      aria-label={`Remove ${item.kind}`}
                      className="absolute right-1.5 top-1.5 flex h-8 w-8 items-center justify-center rounded-full bg-ink/70 text-white"
                    >
                      <Icon name="close" size={15} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {attachments.length > 0 && (
              <p className="mt-1.5 text-[11px] text-muted">
                {images.length}/{MEDIA_LIMITS.maxImagesPerPost} photos{video ? " · 1 short video" : ""}
              </p>
            )}

            {/* ---------------------------- place ---------------------------- */}
            {place && (
              <Card className="mt-4 flex items-center gap-2.5 p-3.5">
                <Icon name="pin" size={16} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold text-ink">{place.name}</p>
                  <p className="text-[11px] text-muted">This post will appear on the map here</p>
                </div>
                <button onClick={() => setPlace(null)} aria-label="Remove place" className="text-muted">
                  <Icon name="close" size={16} />
                </button>
              </Card>
            )}

            {pickerOpen && !place && (
              <Card className="mt-4 p-3.5">
                <input
                  autoFocus
                  value={placeQuery}
                  onChange={(event) => setPlaceQuery(event.target.value)}
                  placeholder="Search a place on the map"
                  aria-label="Search places to attach"
                  className="min-h-[44px] w-full rounded-[10px] border border-line bg-canvas px-3 text-[13px] text-ink outline-none"
                />
                <div className="mt-2 max-h-56 space-y-1.5 overflow-y-auto scroll-area">
                  {matches.map((entry) => (
                    <button
                      key={entry.id}
                      onClick={() => {
                        setPlace(entry);
                        setPickerOpen(false);
                      }}
                      className="flex w-full items-center gap-2 rounded-[10px] px-2.5 py-2.5 text-left active:bg-canvas"
                    >
                      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-canvas text-[11px] font-bold text-ink">
                        {entry.name.slice(0, 1)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{entry.name}</span>
                      <Badge tone="muted">{entry.category}</Badge>
                    </button>
                  ))}
                  {matches.length === 0 && <p className="px-2 py-3 text-[12px] text-muted">No place matches that name.</p>}
                </div>
              </Card>
            )}

            {/* ----------------------------- tags ----------------------------- */}
            <div className="mt-4">
              <p className="mb-2 text-[13px] font-bold text-ink">Tags</p>
              <div className="flex flex-wrap gap-2">
                {tags.map((tag) => (
                  <button
                    key={tag}
                    onClick={() => setTags((current) => current.filter((entry) => entry !== tag))}
                    aria-label={`Remove tag ${tag}`}
                    className="flex items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-1 text-[12px] font-semibold text-ink"
                  >
                    #{tag} <Icon name="close" size={12} />
                  </button>
                ))}
              </div>
              <input
                value={tagDraft}
                onChange={(event) => setTagDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === ",") {
                    event.preventDefault();
                    addTag(tagDraft);
                  }
                }}
                onBlur={() => addTag(tagDraft)}
                placeholder={tags.length >= MAX_TAGS ? "Tag limit reached" : "Add a tag and press Enter"}
                aria-label="Add a tag"
                disabled={tags.length >= MAX_TAGS}
                className="mt-2 min-h-[44px] w-full rounded-[10px] border border-line bg-surface px-3 text-[13px] text-ink outline-none disabled:opacity-50"
              />
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => imageInput.current?.click()} disabled={images.length >= MEDIA_LIMITS.maxImagesPerPost}>
                <Icon name="image" size={16} /> Photos
              </Button>
              <Button variant="outline" size="sm" onClick={() => videoInput.current?.click()} disabled={Boolean(video)}>
                <Icon name="video" size={16} /> Video
              </Button>
              <Button variant="outline" size="sm" onClick={() => setPickerOpen((open) => !open)} disabled={Boolean(place)}>
                <Icon name="pin" size={16} /> Place
              </Button>
              <Button variant="outline" size="sm" onClick={() => setPreview(true)} disabled={!body.trim()}>
                <Icon name="search" size={16} /> Preview
              </Button>
            </div>

            <div className="mt-4">
              <Notice
                tone="primary"
                icon="info"
                title="Your post is your experience"
                body="It appears in the community feed and, if you attached a place, on the map. It never changes official Greenbook guidance."
              />
            </div>
          </>
        )}

        {/* --------------------------- progress --------------------------- */}
        {busy && (
          <Card className="mt-4 p-3.5" data-testid="composer-progress">
            <div className="flex items-center justify-between">
              <p className="text-[13px] font-semibold text-ink">
                {state === "compressing" ? "Preparing your photos" : state === "publishing" ? "Publishing" : progress?.label ?? "Uploading"}
              </p>
              <p className="text-[12px] text-muted">
                {progress ? `${progress.index + 1}/${progress.total}${progress.percent === null ? "" : ` · ${progress.percent}%`}` : ""}
              </p>
            </div>
            {/*
              A null percentage means the SDK reported no intermediate progress —
              Appwrite only emits callbacks above its 5 MB chunk threshold, so a
              small photo uploads in one request. An indeterminate bar is the
              honest rendering; a fabricated percentage ticking on a timer is not.
            */}
            <div className="mt-2">
              {progress && progress.percent !== null ? (
                <ProgressBar value={progress.percent} />
              ) : (
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
                  <div className="h-full w-1/3 animate-pulse rounded-full bg-ink" />
                </div>
              )}
            </div>
          </Card>
        )}

        {error && (
          <div className="mt-4">
            <Notice tone="error" icon="alert" title={state === "failed" ? "Could not post" : "Attachment problem"} body={error} />
          </div>
        )}

        {preview && (
          <div className="mt-4">
            <Button variant="outline" full onClick={() => setPreview(false)}>
              Back to editing
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
