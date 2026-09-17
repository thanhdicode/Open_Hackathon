import { useState } from "react";
import { Avatar, Badge, Card } from "../../components/ui";
import { Icon } from "../../components/icons";
import { COUNTRIES } from "../../data/countries";
import { POST_TYPE_META, type CommunityPost } from "../../lib/phase5/contract";
import { MediaView } from "./MediaView";

/**
 * A community post.
 *
 * Mobile-first and edge-to-edge, but deliberately not a Facebook clone: the
 * palette is the YapYep monochrome system, the metadata row is compact, and the
 * type badge carries information Facebook does not have. Seeded content is marked
 * "Demo" from the stored `is_demo_seed` flag, never from a guess — a synthetic
 * anecdote must never be mistakable for a real student's experience.
 */

export interface PostCardProps {
  post: CommunityPost;
  placeName?: string;
  onOpen: () => void;
  onToggleReaction: () => void;
  onToggleSave: () => void;
  onOpenOnMap?: () => void;
  onTranslate: () => Promise<{ ok: boolean; text?: string; message?: string }>;
  busy?: boolean;
}

/** Compact relative time. Falls back to a date rather than showing "NaN ago". */
export function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function flag(code?: string): string {
  if (!code) return "";
  return COUNTRIES[code as keyof typeof COUNTRIES]?.flag ?? "";
}

export function PostCard({ post, placeName, onOpen, onToggleReaction, onToggleSave, onOpenOnMap, onTranslate, busy }: PostCardProps) {
  const [translation, setTranslation] = useState<{ state: "idle" | "loading" | "done" | "error"; text?: string; message?: string }>({ state: "idle" });
  const meta = POST_TYPE_META[post.postType] ?? POST_TYPE_META.moment;
  const home = flag(post.author.homeCountry);
  const host = flag(post.author.hostCountry);

  async function runTranslate() {
    if (translation.state === "done" || translation.state === "loading") {
      setTranslation({ state: "idle" });
      return;
    }
    setTranslation({ state: "loading" });
    const result = await onTranslate();
    setTranslation(result.ok ? { state: "done", text: result.text } : { state: "error", message: result.message });
  }

  return (
    <Card className="overflow-hidden" data-testid="post-card" data-post-id={post.id}>
      {/* ------------------------------ header ------------------------------ */}
      <button onClick={onOpen} className="flex w-full items-start gap-3 px-4 pt-4 text-left">
        <Avatar initials={post.author.initials} color={post.author.color} size={42} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[14px] font-bold text-ink">{post.author.displayName}</span>
            {post.author.isDemoSeed && <Badge tone="muted">Demo</Badge>}
            <span className={`ml-auto text-[11px] font-medium text-muted`}>{relativeTime(post.createdAt)}</span>
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
            {home && host && (
              <span aria-label={`From ${post.author.homeCountry} to ${post.author.hostCountry}`}>
                {home} → {host}
              </span>
            )}
            {post.universityId && <span>· {post.universityId.toUpperCase()}</span>}
            <span className="rounded-full bg-canvas px-2 py-0.5 text-[10px] font-semibold text-muted">{meta.label}</span>
          </p>
        </div>
      </button>

      {/* ------------------------------- body ------------------------------- */}
      {/*
        The caption is its own button, separate from the author block above it and
        from the action row below it. That matters for automation as much as for
        touch: a click at the centre of the whole card lands on whatever happens to
        be in the middle — an image, or the reaction row — and silently does
        nothing, which reads as "the post will not open". This hook names the
        target that actually opens the post.
      */}
      <button data-testid="open-post" onClick={onOpen} className="mt-2.5 block w-full px-4 text-left">
        <p className="text-[14px] leading-relaxed text-ink">{post.body}</p>
      </button>

      <MediaView media={post.media} variant="card" />

      {/*
        Why this post is here. Only the For You ranker sets `reasons`, so a
        chronological filter shows nothing — which is correct: there is nothing
        to explain about "this is the newest post".
      */}
      {post.reasons && post.reasons.length > 0 && (
        <div data-testid="post-reasons" className="mt-3 flex flex-wrap gap-1.5 px-4">
          {post.reasons.map((reason) => (
            <span key={reason} className="rounded-full border border-line bg-canvas px-2.5 py-1 text-[11px] font-medium text-muted">
              {reason}
            </span>
          ))}
        </div>
      )}

      {/* ------------------------------ context ----------------------------- */}
      {(placeName || post.tags.length > 0) && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 px-4">
          {placeName && (
            <span className="flex items-center gap-1 rounded-full bg-canvas px-2.5 py-1 text-[11px] font-semibold text-ink">
              <Icon name="pin" size={11} /> {placeName}
            </span>
          )}
          {post.tags.slice(0, 4).map((tag) => (
            <span key={tag} className="text-[11px] text-muted">
              #{tag.replace(/[^a-z0-9]/gi, "")}
            </span>
          ))}
        </div>
      )}

      {/* ------------------------------ actions ----------------------------- */}
      <div className="mt-3 flex items-center gap-1 border-t border-line px-2 py-1.5">
        <button
          onClick={onToggleReaction}
          disabled={busy}
          aria-pressed={post.viewerReacted}
          aria-label={post.viewerReacted ? "Remove reaction" : "React to this post"}
          className={`flex min-h-[44px] items-center gap-1.5 rounded-[10px] px-3 text-[13px] font-semibold ${
            post.viewerReacted ? "text-error" : "text-muted"
          }`}
        >
          <Icon name="heart" size={17} filled={post.viewerReacted} /> {post.reactionCount}
        </button>

        <button onClick={onOpen} aria-label="View comments" className="flex min-h-[44px] items-center gap-1.5 rounded-[10px] px-3 text-[13px] font-semibold text-muted">
          <Icon name="chat" size={17} /> {post.commentCount}
        </button>

        <button
          onClick={onToggleSave}
          disabled={busy}
          aria-pressed={post.viewerSaved}
          aria-label={post.viewerSaved ? "Remove from saved" : "Save this post"}
          className={`flex min-h-[44px] items-center gap-1.5 rounded-[10px] px-3 text-[13px] font-semibold ${
            post.viewerSaved ? "text-ink" : "text-muted"
          }`}
        >
          {/*
            No public number, deliberately. A saved-post row is private to the
            saver, so a total cannot be derived without exposing who saved what —
            and the stored column could never be kept honest, because the post row
            is `update(author)` and a reader's save was rejected with 401. What the
            button shows is the one thing it can truthfully show: whether *you*
            saved this.
          */}
          <Icon name="bookmark" size={17} filled={post.viewerSaved} />
          <span className="sr-only">{post.viewerSaved ? "Saved" : "Save"}</span>
        </button>

        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => void runTranslate()}
            aria-pressed={translation.state === "done"}
            aria-label="Translate this post"
            disabled={translation.state === "loading"}
            className={`flex min-h-[44px] items-center gap-1.5 rounded-[10px] px-2.5 text-[12px] font-semibold ${
              translation.state === "done" ? "text-primary" : "text-muted"
            }`}
          >
            <Icon name="translate" size={16} />
          </button>
          {onOpenOnMap && (
            <button onClick={onOpenOnMap} aria-label="Open this place on the map" className="flex min-h-[44px] items-center gap-1.5 rounded-[10px] px-2.5 text-[12px] font-semibold text-muted">
              <Icon name="map" size={16} />
            </button>
          )}
        </div>
      </div>

      {translation.state === "loading" && (
        <p className="border-t border-line bg-canvas px-4 py-2 text-[12px] text-muted">Translating…</p>
      )}

      {translation.state === "done" && translation.text && (
        <div className="border-t border-line bg-canvas px-4 py-2.5">
          <p className="text-[10px] font-bold uppercase tracking-wide text-muted">Translated</p>
          <p className="mt-1 text-[13px] leading-relaxed text-ink">{translation.text}</p>
        </div>
      )}

      {translation.state === "error" && (
        <p className="border-t border-line bg-canvas px-4 py-2 text-[12px] text-muted">{translation.message}</p>
      )}
    </Card>
  );
}
