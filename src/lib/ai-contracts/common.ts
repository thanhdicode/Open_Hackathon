import { z } from "zod";

/**
 * Client mirror of functions/ai-gateway/src/contracts.js.
 *
 * The gateway validates provider output at the server boundary; these schemas
 * validate again in the client so a malformed or tampered response can never
 * reach the UI. The two mirrors are kept honest by
 * scripts/verify/contracts.test.mjs, which runs the same fixtures through both.
 */

export const LanguageCodeSchema = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "must be a BCP-47 language code such as vi, ms, zh-Hans");

export const ConfidenceLabelSchema = z.enum(["low", "medium", "high"]);

export const ConfidenceSchema = z.object({
  label: ConfidenceLabelSchema,
  reason: z.string().min(1),
});

export const ToneModeSchema = z.enum(["casual", "neutral", "academic", "very_respectful"]);

export const AuthorityLevelSchema = z.enum(["A", "B", "C", "D"]);

export const SourceSchema = z.object({
  sourceId: z.string().min(1),
  title: z.string().min(1),
  url: z.string().url(),
  authorityLevel: AuthorityLevelSchema,
  retrievedAt: z.string().optional(),
  freshness: z.enum(["current", "stale", "unknown"]).optional(),
});

/** Gemini spatial output: [ymin, xmin, ymax, xmax] normalized to 0-1000. */
export const Box2DSchema = z
  .object({
    ymin: z.number().int().min(0).max(1000),
    xmin: z.number().int().min(0).max(1000),
    ymax: z.number().int().min(0).max(1000),
    xmax: z.number().int().min(0).max(1000),
  })
  .refine((box) => box.ymin < box.ymax && box.xmin < box.xmax, "box requires ymin<ymax and xmin<xmax");

export const ScenarioDomainSchema = z.enum([
  "food",
  "transport",
  "campus",
  "classroom",
  "group_work",
  "professor",
  "social",
  "housing",
  "banking",
  "sim",
  "health",
  "safety",
  "police",
  "immigration",
  "shopping",
  "religion",
  "events",
  "clubs",
  "part_time",
  "travel",
]);

export const LanguageLevelSchema = z.enum(["beginner", "intermediate", "advanced"]);

export const JourneySchema = z.object({
  home: z.string().length(2),
  host: z.string().length(2),
  city: z.string().optional(),
  university: z.string().optional(),
});

export type Confidence = z.infer<typeof ConfidenceSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type Box2D = z.infer<typeof Box2DSchema>;
export type ToneMode = z.infer<typeof ToneModeSchema>;
export type ScenarioDomain = z.infer<typeof ScenarioDomainSchema>;
export type LanguageLevel = z.infer<typeof LanguageLevelSchema>;
export type Journey = z.infer<typeof JourneySchema>;
