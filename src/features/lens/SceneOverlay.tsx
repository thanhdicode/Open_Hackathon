import { useState } from "react";
import { Badge, Button, Card, Notice } from "../../components/ui";
import { Icon } from "../../components/icons";
import { toPercentBox, type SceneRegion, type SceneResult, type VisualEvidence } from "../../lib/ai-contracts/scene";

/**
 * Immediate on-device overlay (Tier 0).
 *
 * Renders the boxes the browser itself detected, before any network call has
 * returned. This is what makes the photo useful within a second, and it is also
 * the last line of defence: if every vision provider is down, this overlay is
 * still there and the student can still tap a region.
 */
export function EvidenceOverlay({ evidence, imageUrl, note }: { evidence: VisualEvidence; imageUrl: string; note?: string }) {
  const entries = evidence.visibleTexts.filter((entry) => entry.text.trim().length > 0);

  return (
    <div className="space-y-3">
      <Card className="overflow-hidden p-0">
        <div className="relative">
          {/* eslint-disable-next-line jsx-a11y/alt-text -- the photo is the user's own capture */}
          <img src={imageUrl} alt="The photo you scanned, with on-device text detection" className="block w-full" />
          {entries.map((entry, index) => (
            <div
              key={`${index}-${entry.text.slice(0, 12)}`}
              className="absolute rounded-[6px] border-2 border-ink/40 bg-ink/10"
              style={toPercentBox(entry.box)}
              aria-hidden="true"
            />
          ))}
        </div>
      </Card>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="muted">On-device</Badge>
        <Badge tone="primary">{entries.length} text regions</Badge>
        {evidence.visibleLanguages.map((code) => (
          <Badge key={code} tone="muted">
            {code}
          </Badge>
        ))}
      </div>
      {note && <p className="text-[12px] text-muted">{note}</p>}
    </div>
  );
}

/**
 * Interactive annotation over the original photo.
 *
 * The source image is never regenerated or redrawn. Regions are positioned
 * with CSS percentages derived from the provider's normalized 0-1000 boxes, so
 * they stay aligned at every breakpoint without measuring the rendered image.
 */
export function SceneOverlay({ result, imageUrl }: { result: SceneResult; imageUrl: string }) {
  const [selectedId, setSelectedId] = useState<string | null>(result.regions[0]?.id ?? null);
  const selected = result.regions.find((region) => region.id === selectedId) ?? null;
  const uncertainCount = result.regions.filter((region) => region.uncertainty !== "none").length;

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden p-0">
        <div className="relative">
          {/* eslint-disable-next-line jsx-a11y/alt-text -- the photo is the user's own capture */}
          <img src={imageUrl} alt="The photo you scanned, with annotations" className="block w-full" />
          {result.regions.map((region, index) => {
            const box = toPercentBox(region.box);
            const isSelected = region.id === selectedId;
            const tone = region.uncertainty === "high" ? "border-warning" : region.uncertainty === "low" ? "border-warning/60" : "border-primary";
            return (
              <button
                key={region.id}
                onClick={() => setSelectedId(region.id)}
                aria-label={`Region ${index + 1}: ${region.label}${region.uncertainty !== "none" ? " (uncertain)" : ""}`}
                aria-pressed={isSelected}
                className={`absolute rounded-[6px] border-2 transition ${tone} ${isSelected ? "bg-primary/25" : "bg-primary/10"} hover:bg-primary/20`}
                style={box}
              >
                <span className={`absolute -top-0.5 -left-0.5 flex h-5 w-5 items-center justify-center rounded-[4px] text-[11px] font-bold text-white ${region.uncertainty === "high" ? "bg-warning" : "bg-primary"}`}>
                  {index + 1}
                </span>
              </button>
            );
          })}
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="muted">{result.sceneKind}</Badge>
        <Badge tone="primary">{result.regions.length} regions</Badge>
        {result.detectedLanguages.map((code) => (
          <Badge key={code} tone="muted">
            {code}
          </Badge>
        ))}
        {uncertainCount > 0 && <Badge tone="warning">{uncertainCount} uncertain</Badge>}
      </div>

      <Card className="p-4">
        <p className="text-[12px] font-bold uppercase tracking-wide text-muted">What this is</p>
        <p className="mt-1.5 text-[14px] leading-relaxed text-ink">{result.sceneSummary}</p>
      </Card>

      <Notice tone="warning" icon="info" title="What this photo cannot tell you" body={result.safetyNotice} />

      {result.uncertaintyNotes.length > 0 && (
        <Card className="p-4">
          <p className="text-[12px] font-bold uppercase tracking-wide text-muted">Uncertain areas</p>
          <ul className="mt-2 space-y-1.5">
            {result.uncertaintyNotes.map((note) => (
              <li key={note} className="flex items-start gap-2 text-[13px] leading-relaxed text-ink">
                <span className="text-warning">◆</span> {note}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div>
        <p className="mb-2 text-[15px] font-bold text-ink">Tap a region</p>
        <div className="space-y-2">
          {result.regions.map((region, index) => (
            <RegionRow key={region.id} region={region} index={index} selected={region.id === selectedId} onSelect={() => setSelectedId(region.id)} />
          ))}
        </div>
      </div>

      {selected && <RegionDetail region={selected} />}

      {result.usefulPhrases.length > 0 && (
        <Card className="p-4">
          <p className="text-[12px] font-bold uppercase tracking-wide text-primary">Useful things to say here</p>
          <ul className="mt-2 space-y-3">
            {result.usefulPhrases.map((phrase) => (
              <li key={phrase.text}>
                <p className="text-[14px] font-semibold text-ink">{phrase.text}</p>
                {phrase.romanization && <p className="text-[12px] italic text-muted">{phrase.romanization}</p>}
                <p className="text-[13px] text-ink">{phrase.translation}</p>
                <p className="mt-0.5 text-[12px] text-muted">{phrase.whenToUse}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function RegionRow({ region, index, selected, onSelect }: { region: SceneRegion; index: number; selected: boolean; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex w-full min-h-[44px] items-center gap-3 rounded-[12px] border px-3.5 py-3 text-left transition ${selected ? "border-primary bg-primary-soft" : "border-line bg-surface"}`}
    >
      <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] text-[11px] font-bold text-white ${region.uncertainty === "high" ? "bg-warning" : "bg-primary"}`}>{index + 1}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-semibold text-ink">{region.originalText ?? region.label}</span>
        {region.translatedText && <span className="block truncate text-[12px] text-muted">{region.translatedText}</span>}
      </span>
      {region.uncertainty !== "none" && <Badge tone="warning">uncertain</Badge>}
      <Icon name="chevron" size={16} />
    </button>
  );
}

function RegionDetail({ region }: { region: SceneRegion }) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[15px] font-bold text-ink">{region.label}</p>
        <Badge tone={region.confidence === "high" ? "success" : region.confidence === "medium" ? "muted" : "warning"}>{region.confidence} confidence</Badge>
      </div>

      {region.originalText && (
        <p className="mt-2.5 rounded-[10px] bg-canvas px-3 py-2.5 text-[15px] font-medium text-ink">{region.originalText}</p>
      )}
      {region.romanization && <p className="mt-1 text-[12px] italic text-muted">{region.romanization}</p>}
      {region.translatedText && <p className="mt-2 text-[14px] leading-relaxed text-ink">{region.translatedText}</p>}
      {region.meaning && <p className="mt-2 text-[13px] leading-relaxed text-muted">{region.meaning}</p>}
      {region.note && <p className="mt-2 text-[13px] leading-relaxed text-ink">{region.note}</p>}

      {region.uncertainty !== "none" && (
        <p className="mt-3 text-[12px] text-warning">
          This part of the photo was hard to read. Confirm it with the person in front of you before relying on it.
        </p>
      )}
    </Card>
  );
}
