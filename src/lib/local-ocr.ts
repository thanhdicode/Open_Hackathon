import type { VisualEvidence } from "./ai-contracts/scene";

/**
 * On-device OCR (Tier 0).
 *
 * Runs entirely in the browser, so Scene Lens produces a useful annotated photo
 * with no network and no API key. It runs BEFORE any remote call so the student
 * sees text and boxes immediately, and it is also the last line of defence: if
 * every vision provider is unavailable, this evidence alone still drives Stage B
 * reasoning, so the photo never becomes a dead screen.
 *
 * Tesseract is loaded lazily — it is a large dependency and most sessions never
 * reach the point of needing it.
 */

export interface LocalOcrText {
  text: string;
  /** Normalized 0-1000 box, in the same space the provider boxes use. */
  box: { ymin: number; xmin: number; ymax: number; xmax: number };
  confidence: number;
}

export interface LocalOcrResult {
  texts: LocalOcrText[];
  fullText: string;
  /** Language codes actually used, so the caller can report what was attempted. */
  languagesUsed: string[];
  durationMs: number;
  /** True when OCR could not run at all (worker failed, unsupported browser). */
  unavailable: boolean;
  reason?: string;
}

/** Tesseract language packs are 3-letter codes and not 1:1 with BCP-47. */
const TESSERACT_LANGUAGE: Record<string, string> = {
  en: "eng",
  vi: "vie",
  ms: "msa",
  id: "ind",
  th: "tha",
  fil: "tgl",
  "zh-Hans": "chi_sim",
  "zh-Hant": "chi_tra",
  ta: "tam",
  pt: "por",
  km: "khm",
  lo: "lao",
  my: "mya",
};

export function tesseractLanguageFor(code: string | undefined): string | null {
  if (!code) return null;
  return TESSERACT_LANGUAGE[code] ?? TESSERACT_LANGUAGE[code.split("-")[0]] ?? null;
}

/**
 * Build the language list for a recognition pass.
 * English is always included: signage is frequently bilingual and dropping it
 * loses more than the extra language pack costs.
 */
export function ocrLanguageList(preferred: (string | undefined)[]): string[] {
  const codes = new Set<string>(["eng"]);
  for (const code of preferred) {
    const mapped = tesseractLanguageFor(code);
    if (mapped) codes.add(mapped);
  }
  // Tesseract slows down sharply with many packs; three is a sane ceiling.
  return [...codes].slice(0, 3);
}

interface TesseractBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface TesseractWord {
  text?: string;
  confidence?: number;
  bbox?: TesseractBox;
}

interface TesseractLine {
  text?: string;
  confidence?: number;
  bbox?: TesseractBox;
  words?: TesseractWord[];
}

interface TesseractParagraph {
  text?: string;
  bbox?: TesseractBox;
  lines?: TesseractLine[];
}

interface TesseractBlock {
  text?: string;
  bbox?: TesseractBox;
  paragraphs?: TesseractParagraph[];
}

interface TesseractData {
  text?: string;
  /** Present, but EMPTY in Tesseract v7 — see lineBoxesFrom(). */
  lines?: TesseractLine[];
  blocks?: TesseractBlock[];
}

/**
 * Collect line boxes from a Tesseract result.
 *
 * Tesseract v7 no longer populates the top-level `data.lines` / `data.words`
 * shortcuts: measured, they are empty arrays while `data.blocks` holds the real
 * hierarchy. Reading the dead shortcut is why the on-device overlay silently
 * produced nothing. The lines live at `blocks[].paragraphs[].lines[]`.
 */
export function lineBoxesFrom(data: TesseractData): TesseractLine[] {
  const fromBlocks = (data.blocks ?? []).flatMap((block) => (block.paragraphs ?? []).flatMap((paragraph) => paragraph.lines ?? []));
  if (fromBlocks.length > 0) return fromBlocks;
  // Fall back to the legacy shortcut in case a future version repopulates it.
  return data.lines ?? [];
}

function clamp(value: number, max = 1000): number {
  return Math.min(Math.max(Math.round(value), 0), max);
}

/** Convert a pixel bbox into the normalized 0-1000 space the contracts use. */
function normalizeBox(bbox: TesseractBox, width: number, height: number) {
  return {
    ymin: clamp((bbox.y0 / height) * 1000),
    xmin: clamp((bbox.x0 / width) * 1000),
    ymax: clamp((bbox.y1 / height) * 1000),
    xmax: clamp((bbox.x1 / width) * 1000),
  };
}

async function imageSize(file: File): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return size;
    } catch {
      /* fall through to the <img> path */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error("decode failed"));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface LocalOcrOptions {
  /** Languages to try, most likely first. */
  languages?: (string | undefined)[];
  /** Called with 0-1 progress while Tesseract downloads and runs. */
  onProgress?: (progress: number) => void;
  /**
   * Hard ceiling for the whole on-device pass.
   *
   * Tesseract downloads a worker, a wasm core and language data on first use. On
   * a slow link — or in an environment where the worker cannot spawn at all —
   * that can hang indefinitely. On-device OCR is an enhancement, so it must
   * never hold the request: past this deadline the remote path proceeds without
   * it.
   */
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export async function runLocalOcr(file: File, { languages = [], onProgress, timeoutMs = DEFAULT_TIMEOUT_MS, signal }: LocalOcrOptions = {}): Promise<LocalOcrResult> {
  const startedAt = Date.now();
  const languagesUsed = ocrLanguageList(languages);

  const unavailable = (reason: string): LocalOcrResult => ({
    texts: [],
    fullText: "",
    languagesUsed,
    durationMs: Date.now() - startedAt,
    unavailable: true,
    reason,
  });

  let timer: number | undefined;
  const deadline = new Promise<LocalOcrResult>((resolve) => {
    timer = window.setTimeout(() => resolve(unavailable(`timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  });

  const work = (async (): Promise<LocalOcrResult> => {
    const [{ default: Tesseract }, size] = await Promise.all([import("tesseract.js"), imageSize(file)]);
    if (signal?.aborted) throw new Error("aborted");

    const worker = await Tesseract.createWorker(languagesUsed, 1, {
      logger: (message: { status?: string; progress?: number }) => {
        if (onProgress && typeof message.progress === "number") onProgress(message.progress);
      },
    });

    try {
      // `blocks` must be requested explicitly; the default output omits the
      // geometry this overlay depends on.
      const { data } = await worker.recognize(file, {}, { blocks: true, text: true });
      const typed = data as TesseractData;
      const lines = lineBoxesFrom(typed).filter((line) => (line.text ?? "").trim().length > 0 && line.bbox);

      const texts: LocalOcrText[] = lines.map((line) => ({
        text: (line.text ?? "").trim(),
        box: normalizeBox(line.bbox!, size.width, size.height),
        confidence: Math.round(line.confidence ?? 0),
      }));

      return { texts, fullText: (typed.text ?? "").trim(), languagesUsed, durationMs: Date.now() - startedAt, unavailable: false };
    } finally {
      await worker.terminate().catch(() => {});
    }
  })();

  try {
    return await Promise.race([work, deadline]);
  } catch (cause) {
    // OCR failing must never block the flow: the remote path still runs.
    return unavailable(cause instanceof Error ? cause.message : "on-device reading failed");
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

/**
 * Turn device OCR into VisualEvidence, so it can drive Stage B reasoning when
 * every vision provider is down.
 *
 * The text entries carry their own boxes — they ARE the regions, which is why
 * no separate region list exists.
 */
export function evidenceFromLocalOcr(ocr: LocalOcrResult, sceneHint = "A photo the student took."): VisualEvidence | null {
  const withBoxes = ocr.texts.filter((entry) => entry.text.length > 1);
  if (withBoxes.length === 0) return null;

  return {
    scene: sceneHint,
    visibleTexts: withBoxes.slice(0, 8).map((entry) => ({ text: entry.text.slice(0, 120), box: entry.box })),
    objects: [],
    // The device cannot reliably identify the language, so it reports none
    // rather than guessing one.
    visibleLanguages: [],
  };
}
