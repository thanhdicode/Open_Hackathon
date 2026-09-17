import { useRef, useState } from "react";
import { Icon } from "../../components/icons";
import { Skeleton } from "../../components/ui";
import type { PostMedia } from "../../lib/phase5/contract";

/**
 * Renders a post's attachments.
 *
 * Images and video need different treatment and the difference is not cosmetic:
 * an image can be laid out from its box, a video has an intrinsic aspect ratio
 * that must be respected or it letterboxes into a grey band. So video is
 * `w-full h-auto` with a max height, and never cropped.
 *
 * Videos are `preload="metadata"`, which fetches the header (enough for the
 * duration and dimensions) and nothing else. A feed of ten videos that each
 * buffered their first seconds on mount would be several megabytes of traffic
 * for content the student has not asked to watch — the thing the brief calls out
 * explicitly.
 */

export interface MediaViewProps {
  media: PostMedia[];
  /** Card layout is tighter than the detail view. */
  variant?: "card" | "detail";
}

function formatDuration(seconds?: number): string | null {
  if (!seconds || !Number.isFinite(seconds)) return null;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function ImageSlide({ item, variant, multiple }: { item: PostMedia; variant: "card" | "detail"; multiple: boolean }) {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  if (state === "failed") {
    // A broken demo image must not leave a torn card behind, and it must say so
    // rather than collapsing silently into an empty gap.
    return (
      <div className="flex h-32 w-full items-center justify-center rounded-[12px] border border-line bg-canvas text-[12px] text-muted">
        This image could not load
      </div>
    );
  }

  return (
    <div className={`relative w-full ${multiple ? "shrink-0" : ""}`}>
      {state === "loading" && <Skeleton className={`absolute inset-0 ${variant === "detail" ? "h-72" : "h-52"} rounded-[12px]`} />}
      <img
        src={item.url}
        alt={item.alt}
        loading="lazy"
        decoding="async"
        onLoad={() => setState("ready")}
        onError={() => setState("failed")}
        className={`rounded-[12px] border border-line object-cover transition-opacity duration-300 ${
          state === "ready" ? "opacity-100" : "opacity-0"
        } ${variant === "detail" ? "h-72" : "h-52"} ${multiple ? "w-[78vw] max-w-[320px]" : "w-full"}`}
      />
    </div>
  );
}

function VideoSlide({ item, variant }: { item: PostMedia; variant: "card" | "detail" }) {
  const [state, setState] = useState<"idle" | "ready" | "failed">("idle");
  const ref = useRef<HTMLVideoElement | null>(null);
  const duration = formatDuration(item.durationS);

  if (state === "failed") {
    return (
      <div className="flex h-32 w-full items-center justify-center rounded-[12px] border border-line bg-canvas text-[12px] text-muted">
        This video could not play in this browser
      </div>
    );
  }

  return (
    <div className="relative w-full">
      {state === "idle" && (
        <div className={`absolute inset-0 flex items-center justify-center rounded-[12px] border border-line bg-canvas ${variant === "detail" ? "h-72" : "h-56"}`}>
          <Skeleton className="absolute inset-0 rounded-[12px]" />
          <span className="relative flex items-center gap-2 text-[12px] font-semibold text-muted">
            <Icon name="play" size={18} /> Tap to load video
          </span>
        </div>
      )}
      <video
        ref={ref}
        src={item.url}
        controls
        playsInline
        preload="metadata"
        aria-label={item.alt}
        onLoadedData={() => setState("ready")}
        onError={() => setState("failed")}
        className={`rounded-[12px] border border-line bg-black object-contain ${state === "ready" ? "opacity-100" : "opacity-0"} ${
          variant === "detail" ? "max-h-[420px]" : "max-h-[320px]"
        } w-full`}
      />
      {duration && state === "ready" && (
        <span className="pointer-events-none absolute bottom-3 right-3 rounded-full bg-ink/70 px-2 py-0.5 text-[11px] font-semibold text-white">
          {duration}
        </span>
      )}
    </div>
  );
}

export function MediaView({ media, variant = "card" }: MediaViewProps) {
  const [active, setActive] = useState(0);
  const scroller = useRef<HTMLDivElement | null>(null);
  if (!media.length) return null;

  const multiple = media.length > 1;

  function scrollToSlide(index: number) {
    const node = scroller.current;
    if (!node) return;
    const child = node.children[index] as HTMLElement | undefined;
    child?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    setActive(index);
  }

  return (
    <div className="mt-3">
      <div
        ref={scroller}
        onScroll={(event) => {
          // Derive the active dot from the scroll position rather than tracking
          // it separately, so a swipe and a dot tap cannot disagree.
          if (!multiple) return;
          const node = event.currentTarget;
          const ratio = node.scrollLeft / Math.max(1, node.clientWidth);
          setActive(Math.min(media.length - 1, Math.max(0, Math.round(ratio))));
        }}
        className={`scroll-area ${multiple ? "flex snap-x snap-mandatory gap-1.5 overflow-x-auto px-4 pb-1" : "px-4"}`}
      >
        {media.map((item) =>
          item.kind === "video" ? (
            <div key={item.id} className={multiple ? "shrink-0 snap-center" : "w-full"}>
              <VideoSlide item={item} variant={variant} />
            </div>
          ) : (
            <div key={item.id} className={multiple ? "snap-center" : "w-full"}>
              <ImageSlide item={item} variant={variant} multiple={multiple} />
            </div>
          ),
        )}
      </div>

      {multiple && (
        <div className="mt-1.5 flex items-center justify-center gap-1.5 px-4">
          {media.map((item, index) => (
            <button
              key={item.id}
              onClick={() => scrollToSlide(index)}
              aria-label={`Show attachment ${index + 1} of ${media.length}`}
              aria-current={index === active}
              className={`h-1.5 rounded-full transition-all ${index === active ? "w-4 bg-ink" : "w-1.5 bg-line"}`}
            />
          ))}
        </div>
      )}

      {media.some((item) => item.attribution) && (
        <p className="mt-1 px-4 text-[10px] text-muted">{media.find((item) => item.attribution)?.attribution}</p>
      )}
    </div>
  );
}
