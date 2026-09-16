/**
 * Media capture with explicit fallbacks.
 *
 * Every capture path has a non-camera, non-microphone fallback so no student
 * hits a dead end (failsafe matrix): a denied camera still allows a gallery
 * upload, and a denied microphone still allows typing or uploading audio.
 */

export interface CaptureResult {
  file: File;
  source: "camera" | "upload" | "recording";
}

export type CaptureErrorCode = "permission_denied" | "unsupported" | "failed";

export class CaptureError extends Error {
  code: CaptureErrorCode;
  constructor(code: CaptureErrorCode, message: string) {
    super(message);
    this.name = "CaptureError";
    this.code = code;
  }
}

/**
 * Open the platform picker. `capture` asks a mobile browser to open the camera
 * directly; desktop browsers ignore it and show a file dialog instead, which is
 * the correct fallback rather than an error.
 */
export function pickFile({ accept, capture, multiple = false }: { accept: string; capture?: "environment" | "user"; multiple?: boolean }): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    if (capture) input.setAttribute("capture", capture);

    const finish = (files: File[]) => {
      input.remove();
      resolve(files);
    };

    input.addEventListener("change", () => finish(Array.from(input.files ?? [])));
    // Newer browsers fire `cancel`; without it a dismissed dialog leaves the promise pending.
    input.addEventListener("cancel", () => finish([]));
    input.style.display = "none";
    document.body.appendChild(input);
    input.click();
  });
}

export async function pickImage({ preferCamera = false } = {}): Promise<CaptureResult | null> {
  const files = await pickFile({ accept: "image/*", capture: preferCamera ? "environment" : undefined });
  const file = files[0];
  if (!file) return null;
  return { file, source: preferCamera ? "camera" : "upload" };
}

export async function pickAudio(): Promise<CaptureResult | null> {
  const files = await pickFile({ accept: "audio/*" });
  const file = files[0];
  if (!file) return null;
  return { file, source: "upload" };
}

export async function pickDocument(): Promise<CaptureResult | null> {
  const files = await pickFile({ accept: "image/*,application/pdf" });
  const file = files[0];
  if (!file) return null;
  return { file, source: "upload" };
}

/** A live camera preview stream. The caller must call `stop()`. */
export async function openCamera(): Promise<{ stream: MediaStream; stop: () => void }> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CaptureError("unsupported", "This browser cannot open the camera. You can upload a photo instead.");
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    return { stream, stop: () => stream.getTracks().forEach((track) => track.stop()) };
  } catch {
    throw new CaptureError("permission_denied", "Camera access was blocked. You can upload a photo instead.");
  }
}

export function snapshotFromVideo(video: HTMLVideoElement): Promise<File> {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) return Promise.reject(new CaptureError("failed", "The photo could not be captured."));
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new CaptureError("failed", "The photo could not be captured."));
          return;
        }
        resolve(new File([blob], `capture-${Date.now()}.jpg`, { type: "image/jpeg" }));
      },
      "image/jpeg",
      0.92,
    );
  });
}

const RECORDING_MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

export function preferredRecordingMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return RECORDING_MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

export interface ActiveRecording {
  stop: () => Promise<CaptureResult>;
  cancel: () => void;
  mimeType: string;
}

/** Push-to-talk recording. Rejects with a CaptureError the UI can act on. */
export async function startRecording(): Promise<ActiveRecording> {
  const mimeType = preferredRecordingMimeType();
  if (!navigator.mediaDevices?.getUserMedia || !mimeType) {
    throw new CaptureError("unsupported", "Recording is not available in this browser. You can type or upload an audio file instead.");
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    throw new CaptureError("permission_denied", "Microphone access was blocked. You can type or upload an audio file instead.");
  }

  const chunks: BlobPart[] = [];
  const recorder = new MediaRecorder(stream, { mimeType });
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  });
  recorder.start();

  const release = () => stream.getTracks().forEach((track) => track.stop());

  return {
    mimeType,
    cancel: () => {
      if (recorder.state !== "inactive") recorder.stop();
      release();
    },
    stop: () =>
      new Promise<CaptureResult>((resolve, reject) => {
        recorder.addEventListener("stop", () => {
          release();
          const blob = new Blob(chunks, { type: mimeType });
          if (blob.size === 0) {
            reject(new CaptureError("failed", "No audio was captured. Check that your microphone is working."));
            return;
          }
          resolve({ file: new File([blob], `recording-${Date.now()}.webm`, { type: mimeType }), source: "recording" });
        });
        recorder.addEventListener("error", () => {
          release();
          reject(new CaptureError("failed", "Recording failed. You can type instead."));
        });
        recorder.stop();
      }),
  };
}
