import { useRef, useState } from "react";
import { Avatar, Badge, Button, Card, Chip, Notice } from "../../components/ui";
import { Icon } from "../../components/icons";
import { downscaleImage } from "../../lib/appwrite/community";
import { POST_TYPES, POST_TYPE_META, type Place, type PostType } from "../../lib/phase5/contract";

/**
 * Composer.
 *
 * P0 scope, exactly as the brief defines it: text, an optional photo, and an
 * optional place pin. Nothing more — a rich editor is where demo time goes to
 * die, and the value of this screen is that a student can turn something they
 * just learned into a place other students can use.
 *
 * The place picker is what makes a post appear on the map, so it is offered
 * inline rather than hidden behind a menu.
 */

export interface ComposerProps {
  authorName: string;
  authorInitials: string;
  authorColor: string;
  /** Places already loaded by Explore, so the picker needs no extra request. */
  places: Place[];
  onCreate: (input: { body: string; postType: PostType; placeId: string | null; file: File | null }) => Promise<{ ok: boolean; message?: string }>;
  onCancel: () => void;
  defaultPlace?: Place | null;
}

const MAX_BODY = 4000;

export function Composer({ authorName, authorInitials, authorColor, places, onCreate, onCancel, defaultPlace }: ComposerProps) {
  const [body, setBody] = useState("");
  const [postType, setPostType] = useState<PostType>("tip");
  const [place, setPlace] = useState<Place | null>(defaultPlace ?? null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [placeQuery, setPlaceQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  async function pickFile(selected: File | null) {
    setError(null);
    if (!selected) {
      setFile(null);
      setPreview(null);
      return;
    }
    if (!["image/jpeg", "image/png", "image/webp"].includes(selected.type)) {
      setError("Photos must be JPG, PNG or WebP.");
      return;
    }
    const scaled = await downscaleImage(selected, 1600, 0.82);
    setFile(scaled);
    setPreview(URL.createObjectURL(scaled));
  }

  async function submit() {
    if (!body.trim()) {
      setError("Write something useful first.");
      return;
    }
    setSaving(true);
    setError(null);
    const result = await onCreate({ body: body.trim(), postType, placeId: place?.id ?? null, file });
    setSaving(false);
    if (!result.ok) setError(result.message ?? "Could not post. Try again.");
  }

  const matches = placeQuery.trim()
    ? places.filter((entry) => entry.name.toLowerCase().includes(placeQuery.trim().toLowerCase())).slice(0, 12)
    : places.slice(0, 12);

  return (
    <div className="flex h-full flex-col bg-canvas">
      <div className="flex items-center justify-between border-b border-line bg-surface px-5 py-3">
        <button onClick={onCancel} className="min-h-[44px] text-[15px] font-semibold text-muted">
          Cancel
        </button>
        <p className="text-[15px] font-bold text-ink">Share something</p>
        <Button size="sm" onClick={() => void submit()} disabled={saving || !body.trim()}>
          {saving ? "Posting…" : "Post"}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scroll-area px-5 py-4">
        <div className="flex items-start gap-3">
          <Avatar initials={authorInitials} color={authorColor} size={40} />
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-bold text-ink">{authorName}</p>
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value.slice(0, MAX_BODY))}
              rows={6}
              autoFocus
              placeholder="Share something useful…"
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
          ref={fileInput}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(event) => void pickFile(event.target.files?.[0] ?? null)}
        />

        {preview && (
          <div className="relative mt-4">
            <img src={preview} alt="Your photo preview" className="h-44 w-full rounded-[12px] border border-line object-cover" />
            <button
              onClick={() => void pickFile(null)}
              className="absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-full bg-ink/70 text-white"
              aria-label="Remove photo"
            >
              <Icon name="close" size={16} />
            </button>
          </div>
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

        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
            <Icon name="image" size={16} /> Photo
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPickerOpen((open) => !open)} disabled={Boolean(place)}>
            <Icon name="pin" size={16} /> Place
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPostType("tip")}>
            <Icon name="check" size={16} /> Tip
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPostType("question")}>
            <Icon name="chat" size={16} /> Question
          </Button>
        </div>

        {error && (
          <div className="mt-4">
            <Notice tone="error" icon="alert" title="Could not post" body={error} />
          </div>
        )}

        <div className="mt-4">
          <Notice
            tone="primary"
            icon="info"
            title="Your post is your experience"
            body="It appears in the community feed and, if you attached a place, on the map. It never changes official Greenbook guidance."
          />
        </div>
      </div>
    </div>
  );
}
