import { Component, type ErrorInfo, type ReactNode } from "react";
import { COMPUTER } from "@cloudroom/domain";
import { FixPrompt } from "@/components/ui/fix-prompt";
import { isPhoneRelay, macIsOff } from "@/cloud/cloud-mode";
import { crashFixPrompt, phoneCrashFixPrompt } from "@/lib/fix-prompts";

const MISSING_CODE =
  /Importing a module script failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Unable to preload CSS/i;

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  override state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[Cloudroom] the app crashed", error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) {
      return this.props.children;
    }
    if (macIsOff() && MISSING_CODE.test(error.message)) {
      return (
        <div className="flex h-dvh w-full items-center justify-center bg-background p-6 text-foreground">
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-6">
            <h1 className="text-base font-medium">
              This screen needs your {COMPUTER}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Your phone hasn&apos;t saved this screen yet. Open Cloudroom on
              your {COMPUTER}, open the app here once, and it will work with the{" "}
              {COMPUTER}
              off too. Your Cloud threads still work.
            </p>
            <button
              type="button"
              className="mt-4 w-full cursor-pointer rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
              onClick={() => window.location.assign("/")}
            >
              Back to threads
            </button>
          </div>
        </div>
      );
    }
    const prompt = isPhoneRelay()
      ? phoneCrashFixPrompt(
          error.message,
          window.location.hostname,
          window.location.pathname,
          macIsOff(),
        )
      : crashFixPrompt(error.message);
    return (
      <div className="flex h-dvh w-full items-center justify-center bg-background p-6 text-foreground">
        <div className="w-full max-w-md rounded-lg border border-border bg-card p-6">
          <h1 className="text-base font-medium">
            Cloudroom hit an error and stopped
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            A reload is safe. Your threads live on the server and an unsent
            draft is kept locally. If this repeats, open the browser console and
            send us the message below.
          </p>
          <details className="mt-4">
            <summary className="cursor-pointer text-sm text-muted-foreground">
              Error details
            </summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border p-3 text-xs">
              {error.stack ?? error.message}
            </pre>
          </details>
          <button
            type="button"
            className="mt-4 w-full cursor-pointer rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
            onClick={() => window.location.reload()}
          >
            Reload Cloudroom
          </button>
          <FixPrompt className="mt-4" prompt={prompt} />
        </div>
      </div>
    );
  }
}
