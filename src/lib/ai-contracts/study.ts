import { z } from "zod";
import { ConfidenceSchema, ScenarioDomainSchema, SourceSchema } from "./common";

/** Study Copilot contracts — general, assignment and lecture variants. */
export const StudyModeSchema = z.enum([
  "professor_message",
  "group_chat",
  "slide",
  "lecture_audio",
  "whiteboard",
  "assignment",
  "vocabulary",
  "essay_draft",
  "meeting_summary",
  "presentation",
]);

export const StudySectionSchema = z.object({
  label: z.string().min(1),
  body: z.string().optional(),
  items: z.array(z.string()).optional(),
});

export const ActionItemSchema = z.object({
  text: z.string().min(1),
  owner: z.string().optional(),
  dueHint: z.string().optional(),
});

export const TerminologyItemSchema = z.object({
  term: z.string().min(1),
  plainMeaning: z.string().min(1),
  academicUsage: z.string().optional(),
});

export const PracticeSuggestionSchema = z.object({
  scenarioGoal: z.string().min(1),
  domain: ScenarioDomainSchema,
});

export const StudyResultSchema = z.object({
  mode: StudyModeSchema,
  summary: z.string().min(1),
  sections: z.array(StudySectionSchema).min(1).max(6),
  actionItems: z.array(ActionItemSchema).max(8),
  questionsToAsk: z.array(z.string()).max(6),
  terminology: z.array(TerminologyItemSchema).max(10),
  practiceSuggestion: PracticeSuggestionSchema.optional(),
  confidence: ConfidenceSchema,
  sources: z.array(SourceSchema).max(6),
});

export const AssignmentResultSchema = z.object({
  deliverables: z.array(ActionItemSchema).min(1).max(10),
  deadlineHints: z
    .array(z.object({ text: z.string().min(1), source: z.string().min(1), explicit: z.boolean() }))
    .max(8),
  rubric: z
    .array(
      z.object({
        criterion: z.string().min(1),
        detail: z.string().optional(),
        weight: z.string().optional(),
      }),
    )
    .max(10),
  ambiguities: z.array(z.string()).max(8),
  questionsToAsk: z.array(z.string()).max(8),
  confidence: ConfidenceSchema,
});

export const LectureResultSchema = z.object({
  transcript: z.string(),
  detectedLanguages: z.array(z.string()).min(1),
  translation: z.string().optional(),
  concepts: z
    .array(
      z.object({
        term: z.string().min(1),
        explanation: z.string().min(1),
        importance: z.enum(["core", "supporting", "tangential"]),
      }),
    )
    .max(12),
  unclearMoments: z.array(z.string()).max(6),
  actionItems: z.array(ActionItemSchema).max(8),
  confidence: ConfidenceSchema,
});

export type StudyMode = z.infer<typeof StudyModeSchema>;
export type StudyResult = z.infer<typeof StudyResultSchema>;
export type AssignmentResult = z.infer<typeof AssignmentResultSchema>;
export type LectureResult = z.infer<typeof LectureResultSchema>;
export type StudyAnalysis = StudyResult | AssignmentResult | LectureResult;
