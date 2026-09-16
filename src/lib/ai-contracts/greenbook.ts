import { z } from "zod";

/**
 * Living Greenbook contracts — the grounded answer.
 *
 * This mirrors functions/ai-gateway/src/contracts.js (greenbookAnswer and its
 * evidence shapes). The parity test in scripts/verify/contracts.test.mjs runs
 * the same fixtures through both sides, which is what keeps the duplication
 * honest — the Appwrite function must stay self-contained when deployed.
 *
 * The bounds here are not decoration. Groq's strict mode reserves output tokens
 * equal to the schema's THEORETICAL maximum, so an unbounded array or string
 * makes a request fail BEFORE the model runs. Every array and string below is
 * therefore capped, matching the server exactly.
 */

export const GreenbookAuthoritySchema = z.enum(["A", "B", "C", "D"]);

/** One retrieved fact, as the retrieval layer hands it to the model. */
export const GreenbookEvidenceFactSchema = z.object({
  factId: z.string().min(1).max(64),
  sourceId: z.string().min(1).max(64),
  chapter: z.string().max(40),
  claim: z.string().min(1).max(1200),
  action: z.string().max(1200).nullable().optional(),
  authority: GreenbookAuthoritySchema,
  status: z.string().max(32),
  checkedAt: z.string().max(40).optional(),
});

/** A source the answer is permitted to cite. */
export const GreenbookEvidenceSourceSchema = z.object({
  sourceId: z.string().min(1).max(64),
  title: z.string().min(1).max(300),
  url: z.string().max(2048),
  authority: GreenbookAuthoritySchema,
});

/**
 * The grounded answer.
 *
 * `citedSourceIds` is filtered against the evidence packet's allowlist in
 * src/lib/greenbook/ask.ts before it ever reaches the student, so a model that
 * invents a citation loses that citation rather than shipping it.
 */
export const GreenbookAnswerSchema = z.object({
  answer: z.string().min(1).max(2400),
  whatToDo: z.array(z.string().max(400)).max(8),
  whatToPrepare: z.array(z.string().max(400)).max(8),
  whatToSay: z.array(z.string().max(400)).max(6),
  warnings: z.array(z.string().max(400)).max(5),
  confidence: z.enum(["low", "medium", "high"]),
  citedSourceIds: z.array(z.string().max(64)).max(12),
});
