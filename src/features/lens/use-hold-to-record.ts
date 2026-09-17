import { useEffect, useRef, useState } from "react";
import { startRecording, type ActiveRecording } from "./capture.ts";

type HoldToRecordOptions = {
  onCapture: (file: File) => Promise<void>;
  onError: (error: unknown) => void;
};

type ControllerOptions = HoldToRecordOptions & {
  start: () => Promise<ActiveRecording>;
  onRecordingChange: (recording: boolean) => void;
};

export function createHoldToRecordController({ start, onCapture, onError, onRecordingChange }: ControllerOptions) {
  let active: ActiveRecording | null = null;
  let pressed = false;
  let releaseRequested = false;
  let stopping = false;

  async function finish(next: ActiveRecording) {
    if (stopping) return;
    stopping = true;
    if (active === next) active = null;
    releaseRequested = false;
    onRecordingChange(false);
    try {
      const captured = await next.stop();
      await onCapture(captured.file);
    } catch (error) {
      onError(error);
    } finally {
      stopping = false;
    }
  }

  async function begin() {
    if (pressed || active || stopping) return;
    pressed = true;
    releaseRequested = false;
    try {
      const next = await start();
      active = next;
      onRecordingChange(true);
      if (!pressed || releaseRequested) await finish(next);
    } catch (error) {
      pressed = false;
      releaseRequested = false;
      onRecordingChange(false);
      onError(error);
    }
  }

  async function end() {
    pressed = false;
    releaseRequested = true;
    if (active) await finish(active);
  }

  function cancel() {
    pressed = false;
    releaseRequested = true;
    active?.cancel();
    active = null;
    onRecordingChange(false);
  }

  return { begin, end, cancel };
}

/**
 * Push-to-talk controller. The microphone permission request is asynchronous,
 * so a quick finger release can arrive before MediaRecorder exists. The pending
 * release is remembered and stops the recorder as soon as it is ready.
 */
export function useHoldToRecord({ onCapture, onError }: HoldToRecordOptions) {
  const [recording, setRecording] = useState(false);
  const callbacks = useRef({ onCapture, onError });
  callbacks.current = { onCapture, onError };
  const controller = useRef<ReturnType<typeof createHoldToRecordController> | null>(null);
  if (!controller.current) {
    controller.current = createHoldToRecordController({
      start: startRecording,
      onCapture: (file) => callbacks.current.onCapture(file),
      onError: (error) => callbacks.current.onError(error),
      onRecordingChange: setRecording,
    });
  }

  useEffect(() => () => {
    controller.current?.cancel();
  }, []);

  return { recording, begin: controller.current.begin, end: controller.current.end };
}
