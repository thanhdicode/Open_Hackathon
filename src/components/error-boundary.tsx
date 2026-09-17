import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * The last line of defence against a white screen.
 *
 * WHY THIS EXISTS
 *
 * The app had no boundary at all, so a single throw during render unmounted the
 * entire tree and left a blank page with no navigation and no way back. That is
 * not a hypothetical: a contribution row whose `tags` column held plain strings
 * while the contract declared objects threw inside the place sheet, and opening
 * one place took the whole map — and the whole app — down with it. A missing
 * `.replace` guard should cost one card, not the session.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not retry automatically. A render error is usually deterministic, so
 * silently re-rendering the same broken subtree produces a loop rather than a
 * recovery. The student gets a sentence, a way to reload, and — because the
 * journey and session live in Appwrite rather than in component state — a reload
 * puts them back where they were.
 *
 * It also does not swallow the error: it is logged with its component stack, so a
 * boundary that hides a bug still leaves a trace of it.
 */

interface Props {
  children: ReactNode;
}

interface State {
  message: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { message: null };

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : "Unknown error" };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[yapyep] render error", error, info.componentStack);
  }

  render() {
    if (this.state.message === null) return this.props.children;

    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas px-6">
        <div className="w-full max-w-[420px] rounded-[16px] border border-line bg-surface p-6 text-center">
          <p className="text-[17px] font-bold text-ink">Something broke on this screen</p>
          <p className="mt-2 text-[13px] leading-relaxed text-muted">
            Your journey and everything you have posted are safe — nothing was lost. Reload to carry on.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="mt-5 min-h-[46px] w-full rounded-[12px] bg-ink px-4 text-[15px] font-semibold text-white active:scale-[.98]"
          >
            Reload YapYep
          </button>
          {/*
            The message is shown, not hidden. A demo that fails is far more useful
            when the person holding the phone can read what failed.
          */}
          <p className="mt-4 break-words text-[11px] text-muted">{this.state.message}</p>
        </div>
      </div>
    );
  }
}
