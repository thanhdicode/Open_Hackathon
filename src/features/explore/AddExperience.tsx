import { useRef, useState } from "react";
import { Button, Card, Chip, Notice } from "../../components/ui";
import { ScreenHeader, Scroll } from "../../components/shell";
import { Icon } from "../../components/icons";
import { downscaleImage } from "../../lib/appwrite/community";
import { addContribution } from "../../lib/appwrite/explore";
import { EXPERIENCE_TAGS, VISIT_CONTEXTS, type Place } from "../../lib/phase5/contract";

/**
 * Add experience — the student's half of the two-layer place model.
 *
 * What this writes is an EXPERIENCE, never a fact. It lands in
 * `place_contributions`, which is a different table from `places`, and the
 * Greenbook gate refuses anything below Tier A/B — so a student saying "this
 * clinic is cheap" can never be promoted into official guidance. The copy on
 * screen says so, because a student should know what they are contributing to.
 */

export interface AddExperienceProps {
  place: Place;
  userId: string;
  countryCode: string;
  universityId: string;
  onBack: () => void;
  onSaved: (note: string) => void;
}

const MAX_NOTE = 1200;

export function AddExperience({ place, userId, countryCode, universityId, onBack, onSaved }: AddExperienceProps) {
  const [note, setNote] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [visitContext, setVisitContext] = useState<string>("first_week");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
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
    // Downscale before previewing so a 12 MP phone photo does not sit in memory
    // twice while the student types.
    const scaled = await downscaleImage(selected, 1600, 0.82);
    setFile(scaled);
    setPreview(URL.createObjectURL(scaled));
  }

  async function submit() {
    if (!note.trim()) {
      setError("Write a short note about what this place is like.");
      return;
    }
    setSaving(true);
    setError(null);
    const result = await addContribution({
      placeId: place.id,
      authorId: userId,
      note,
      countryCode,
      universityId,
      tags,
      visitContext,
      file,
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onSaved(note.trim());
  }

  return (
    <div className="flex h-full flex-col bg-canvas">
      <ScreenHeader title="Add experience" onBack={onBack} />
      <Scroll className="px-5 py-4">
        <Card className="p-4">
          <div className="flex items-center gap-2">
            <Icon name="pin" size={16} />
            <div className="min-w-0">
              <p className="truncate text-[14px] font-bold text-ink">{place.name}</p>
              <p className="text-[12px] text-muted">
                {place.address || "Map place"} · {place.source === "seed_pack_researched" ? "reviewed anchor" : "OpenStreetMap"}
              </p>
            </div>
          </div>
        </Card>

        <div className="mt-4">
          <label htmlFor="experience-note" className="mb-1.5 block text-[13px] font-bold text-ink">
            What was it like?
          </label>
          <textarea
            id="experience-note"
            value={note}
            onChange={(event) => setNote(event.target.value.slice(0, MAX_NOTE))}
            rows={5}
            placeholder="Good study place, cheap food, quiet in the morning…"
            className="w-full rounded-[12px] border border-line bg-surface px-3.5 py-3 text-[14px] leading-relaxed text-ink outline-none placeholder:text-muted focus:border-ink"
          />
          <p className="mt-1 text-right text-[11px] text-muted">
            {note.length}/{MAX_NOTE}
          </p>
        </div>

        <div className="mt-4">
          <p className="mb-2 text-[13px] font-bold text-ink">When did you go?</p>
          <div className="flex flex-wrap gap-2">
            {VISIT_CONTEXTS.map((context) => (
              <Chip key={context.key} active={visitContext === context.key} onClick={() => setVisitContext(context.key)}>
                {context.label}
              </Chip>
            ))}
          </div>
        </div>

        <div className="mt-4">
          <p className="mb-2 text-[13px] font-bold text-ink">Anything worth flagging?</p>
          <div className="flex flex-wrap gap-2">
            {EXPERIENCE_TAGS.map((tag) => (
              <Chip
                key={tag.key}
                active={tags.includes(tag.key)}
                onClick={() => setTags((current) => (current.includes(tag.key) ? current.filter((key) => key !== tag.key) : [...current, tag.key]))}
              >
                {tag.label}
              </Chip>
            ))}
          </div>
        </div>

        <div className="mt-4">
          <p className="mb-2 text-[13px] font-bold text-ink">Add a photo (optional)</p>
          <input
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(event) => void pickFile(event.target.files?.[0] ?? null)}
          />
          {preview ? (
            <div className="relative">
              <img src={preview} alt="Your photo preview" className="h-40 w-full rounded-[12px] border border-line object-cover" />
              <button
                onClick={() => void pickFile(null)}
                className="absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-full bg-ink/70 text-white"
                aria-label="Remove photo"
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          ) : (
            <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
              <Icon name="camera" size={16} /> Choose photo
            </Button>
          )}
        </div>

        <div className="mt-4">
          <Notice
            tone="primary"
            icon="info"
            title="This is student experience, not official guidance"
            body="Your note appears on the place as lived experience. Official rules stay with their official source in the Greenbook."
          />
        </div>

        {error && (
          <div className="mt-4">
            <Notice tone="error" icon="alert" title="Could not save" body={error} />
          </div>
        )}

        <div className="mt-5">
          <Button variant="primary" size="lg" full onClick={() => void submit()} disabled={saving || !note.trim()}>
            {saving ? "Saving…" : "Share experience"}
          </Button>
        </div>
      </Scroll>
    </div>
  );
}
