import { z } from "zod";
import { Box2DSchema, ConfidenceLabelSchema, ConfidenceSchema, LanguageCodeSchema } from "./common";

/**
 * VisualEvidenceSchema — Stage A output.
 *
 * What a vision provider is allowed to produce: observation only. No
 * translation, no interpretation, no advice. Keeping this small is what lets a
 * vision provider finish inside its output-token budget instead of timing out.
 *
 * The device's own OCR produces this shape too, which is why Scene Lens still
 * works when every vision provider is unavailable.
 *
 * The item caps are a hard budget: a strict structured-output mode reserves
 * output tokens equal to the schema's theoretical maximum, so generous caps get
 * the request rejected on a free tier with a per-minute output ceiling.
 */
export const VisualEvidenceSchema = z.object({
  scene: z.string().min(1).max(240),
  visibleTexts: z
    .array(
      z.object({
        text: z.string().min(1).max(120),
        language: z.string().optional(),
        box: Box2DSchema,
      }),
    )
    .max(8),
  objects: z
    .array(
      z.object({
        label: z.string().min(1).max(40),
        box: Box2DSchema.optional(),
      }),
    )
    .max(5),
  visibleLanguages: z.array(z.string()).max(3),
});

export type VisualEvidence = z.infer<typeof VisualEvidenceSchema>;

/**
 * SceneResultSchema / SceneRegionSchema — the annotated photo contract.
 *
 * Regions carry normalized boxes (0-1000). The renderer converts them to
 * rendered-image coordinates; the source image is never regenerated.
 */
export const SceneRegionSchema = z.object({
  id: z.string().min(1).max(16),
  kind: z.enum(["text", "object", "mixed"]),
  box: Box2DSchema,
  label: z.string().min(1).max(60),
  originalText: z.string().max(120).optional(),
  translatedText: z.string().max(160).optional(),
  romanization: z.string().max(160).optional(),
  meaning: z.string().max(200).optional(),
  uncertainty: z.enum(["none", "low", "high"]),
  confidence: ConfidenceLabelSchema,
  note: z.string().max(200).optional(),
});

/**
 * Stage B output.
 *
 * Bounded for the same reason as VisualEvidence: a strict structured-output
 * mode reserves output tokens equal to the schema's theoretical maximum, so a
 * generous schema makes the request unservable on a provider with a per-minute
 * output ceiling.
 */
export const SceneResultSchema = z.object({
  sceneSummary: z.string().min(1).max(300),
  sceneKind: z.enum(["menu", "sign", "document", "product", "place", "screen", "other"]),
  detectedLanguages: z.array(LanguageCodeSchema).min(1).max(4),
  targetLanguage: LanguageCodeSchema,
  regions: z.array(SceneRegionSchema).max(8),
  usefulPhrases: z
    .array(
      z.object({
        text: z.string().min(1).max(120),
        translation: z.string().min(1).max(160),
        romanization: z.string().max(160).optional(),
        whenToUse: z.string().min(1).max(140),
      }),
    )
    .max(4),
  uncertaintyNotes: z.array(z.string().max(200)).max(3),
  /** Always populated: states what the image cannot establish. */
  safetyNotice: z.string().min(1).max(280),
  confidence: ConfidenceSchema,
});

export type SceneRegion = z.infer<typeof SceneRegionSchema>;
export type SceneResult = z.infer<typeof SceneResultSchema>;

/** CSS-percentage rectangle. Resolution independent, so the overlay never needs pixel measurement. */
export interface PercentBox {
  left: string;
  top: string;
  width: string;
  height: string;
}

/**
 * Convert a normalized 0-1000 box into CSS percentages.
 *
 * The overlay is positioned against the rendered <img>, so percentages stay
 * correct at every breakpoint and no rendered-image measurement is required.
 * Values are clamped so a provider box can never paint outside the image.
 */
export function toPercentBox(box: z.infer<typeof Box2DSchema>): PercentBox {
  const clamp = (value: number) => Math.min(Math.max(value, 0), 1000);
  const xmin = clamp(box.xmin);
  const ymin = clamp(box.ymin);
  const xmax = clamp(Math.max(box.xmax, xmin));
  const ymax = clamp(Math.max(box.ymax, ymin));
  return {
    left: `${xmin / 10}%`,
    top: `${ymin / 10}%`,
    width: `${(xmax - xmin) / 10}%`,
    height: `${(ymax - ymin) / 10}%`,
  };
}
