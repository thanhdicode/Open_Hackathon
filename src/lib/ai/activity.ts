import { useCallback, useEffect, useRef, useState } from "react";
import { AiError, type AiErrorCode, type AiMeta } from "../ai-contracts/client";

/**
 * Real AI activity state.
 *
 * There is exactly one in-flight provider request per operation, so the UI
 * reports the phases we can actually observe — validating input locally,
 * the request being in flight, and the response being applied. It never walks
 * a fixed list of steps on a timer, and it never shows chain-of-thought.
 *
 * `label` describes what the single in-flight request is doing, which is
 * accurate for the whole duration rather than a fabricated per-step progress.
 */
export type ActivityStatus = "idle" | "validating" | "working" | "applying" | "done" | "error";

export interface ActivityState {
  status: ActivityStatus;
  /** User-safe description of the current work. Never model reasoning. */
  label: string;
  /** Milliseconds since the request started; drives the elapsed indicator. */
  elapsedMs: number;
  error?: { code: AiErrorCode; message: string; retryable: boolean };
  meta?: AiMeta;
}

const IDLE: ActivityState = { status: "idle", label: "", elapsedMs: 0 };

export interface RunOptions {
  /** Shown while the request is in flight. */
  label: string;
  /** Shown while local input checks run, before any request is sent. */
  validatingLabel?: string;
}

export function useAiActivity() {
  const [state, setState] = useState<ActivityState>(IDLE);
  const startedAt = useRef<number | null>(null);
  const timer = useRef<number | null>(null);
  const cancelled = useRef(false);

  const stopTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => () => stopTimer(), [stopTimer]);

  const reset = useCallback(() => {
    stopTimer();
    startedAt.current = null;
    cancelled.current = false;
    setState(IDLE);
  }, [stopTimer]);

  const cancel = useCallback(() => {
    cancelled.current = true;
    stopTimer();
    startedAt.current = null;
    setState(IDLE);
  }, [stopTimer]);

  /**
   * Run one AI operation with real activity reporting.
   * `work` receives an abort signal and must be the only provider call.
   */
  const run = useCallback(
    async <T>({ label, validatingLabel }: RunOptions, work: (signal: AbortSignal) => Promise<T>): Promise<T | null> => {
      cancelled.current = false;
      stopTimer();
      startedAt.current = Date.now();

      if (validatingLabel) setState({ status: "validating", label: validatingLabel, elapsedMs: 0 });

      timer.current = window.setInterval(() => {
        if (startedAt.current === null) return;
        setState((previous) => (previous.status === "idle" || previous.status === "done" || previous.status === "error" ? previous : { ...previous, elapsedMs: Date.now() - (startedAt.current ?? Date.now()) }));
      }, 200);

      setState({ status: "working", label, elapsedMs: 0 });

      const controller = new AbortController();
      try {
        const value = await work(controller.signal);
        stopTimer();
        if (cancelled.current) return null;
        setState((previous) => ({ ...previous, status: "applying", elapsedMs: previous.elapsedMs }));
        return value;
      } catch (cause) {
        stopTimer();
        if (cancelled.current) return null;
        const error =
          cause instanceof AiError
            ? { code: cause.code, message: cause.message, retryable: cause.retryable }
            : { code: "AI_UNAVAILABLE" as AiErrorCode, message: "Something went wrong. Please try again.", retryable: true };
        setState({ status: "error", label: "", elapsedMs: Date.now() - (startedAt.current ?? Date.now()), error });
        return null;
      } finally {
        startedAt.current = null;
      }
    },
    [stopTimer],
  );

  const finish = useCallback(
    (meta?: ActivityState["meta"]) => {
      stopTimer();
      setState({ status: "done", label: "", elapsedMs: 0, meta });
    },
    [stopTimer],
  );

  return { state, run, finish, reset, cancel, isBusy: state.status === "working" || state.status === "validating" || state.status === "applying" };
}
