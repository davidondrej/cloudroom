// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ConversationMessageContent } from "./ConversationMessageContent";
import { RouteNavigationProvider } from "@/components/ui/app-route-anchor";
import { childLoginFailure } from "./ChildLoginFix";

// The child's harness, as the app knows it; undefined while the thread is unknown.
const harness = vi.hoisted(() => ({ providerId: undefined as string | undefined }));
vi.mock("@/hooks/queries/thread-queries", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useThread: () => ({ data: harness.providerId ? { providerId: harness.providerId } : undefined }),
}));
import { generatedConversationBodySlice } from "./GeneratedConversationMessage";

// The exact failure from thr_6fhscd6pyz: Pi's ChatGPT token was rotated elsewhere.
const PI_REFRESH = `[Cloudroom] Child thread "GPT review: Cursor accounts" (cr_child_6afa) failed or its outcome is uncertain. Cause: OAuth refresh failed for openai-codex: OpenAI Codex token refresh failed (401): {
  "error": { "code": "refresh_token_reused" }
}. Its turn did not finish; resend the task if it still matters. Check it with \`room-cli thread output cr_child_6afa\` before deciding next steps.`;
// The app's notice for a child in a sandbox of its own whose cloud start was rejected.
const CODEX_NOT_STARTED = `[Cloudroom] Child thread "GPT review" (thr_child) failed or its outcome is uncertain. Cause: Connect your ChatGPT subscription to use Codex in Cloud. Your prompt is saved. It did not start.`;

function renderFailed(text: string, threadId: string) {
  return render(
    <MemoryRouter>
      <RouteNavigationProvider>
        <ConversationMessageContent
          role="user"
          initiator="system"
          originKind={null}
          senderThreadId={null}
          senderThreadTitle={null}
          senderIsPluginSideChat={false}
          systemMessageKind="child-failed"
          systemMessageSubject={{ kind: "thread", threadId, threadName: "GPT review" }}
          attachments={null}
          mentions={[]}
          text={text}
          threadId="thr_parent"
          turnRequest={{ isGrouped: false, kind: "message", status: "accepted" }}
          projectId="proj_demo"
        />
      </RouteNavigationProvider>
    </MemoryRouter>,
  );
}

afterEach(() => { cleanup(); harness.providerId = undefined; });
// A Codex child whose token expired mid-task: the text alone doesn't say which login.
const CODEX_401 = `[Cloudroom] Child thread "GPT review" (thr_codex) failed or its outcome is uncertain. Cause: 401 Unauthorized. Its turn did not finish; resend the task if it still matters. Check it with \`room-cli thread output thr_codex\` before deciding next steps.`;

describe("childLoginFailure", () => {
  it("names the login Cloudroom can redo", () => {
    expect(childLoginFailure("connect Codex before starting cloud work")).toEqual({ signIn: "codex", notStarted: false });
    expect(childLoginFailure("Connect your Cursor account to use Cursor in Cloud. It did not start.")).toEqual({ signIn: "cursor", notStarted: true });
  });
  it("flags other broken logins without a sign-in button", () => {
    expect(childLoginFailure(generatedConversationBodySlice({ initiator: "system", text: PI_REFRESH }).text)).toEqual({ signIn: null, notStarted: false });
    expect(childLoginFailure("connect Claude Code before starting cloud work")).toEqual({ signIn: null, notStarted: false });
  });
  it("ignores failures that are not about logins", () => {
    expect(childLoginFailure("process exited with signal 9")).toBeNull();
  });
});

describe("child login fix row", () => {
  it("keeps the cause of a child that did not start", () => {
    expect(generatedConversationBodySlice({ initiator: "system", text: CODEX_NOT_STARTED }).text).toBe("Connect your ChatGPT subscription to use Codex in Cloud. Your prompt is saved. It did not start.");
  });

  it("opens Codex sign-in for the child that never started", () => {
    const opened = vi.fn();
    window.addEventListener("cloudroom:connect-codex", opened);
    renderFailed(CODEX_NOT_STARTED, "thr_child");
    expect(screen.getByText("needs sign-in")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in to ChatGPT" }));
    expect((opened.mock.calls[0]![0] as CustomEvent).detail).toEqual({ child: "thr_child" });
    window.removeEventListener("cloudroom:connect-codex", opened);
  });

  it("explains a login it can't redo, without a sign-in button", () => {
    renderFailed(PI_REFRESH, "thr_child_pi");
    expect(screen.getByText(/login expired or was rejected/)).toBeTruthy();
    expect(screen.queryByText(/^Sign in to /)).toBeNull();
    expect(screen.getByRole("button", { name: "Run with Claude instead" })).toBeTruthy();
  });

  it("asks the parent, never retries, for a started child with a thr_ ID", () => {
    harness.providerId = "codex";
    const opened = vi.fn();
    window.addEventListener("cloudroom:connect-codex", opened);
    renderFailed(CODEX_401, "thr_codex");
    fireEvent.click(screen.getByRole("button", { name: "Sign in to ChatGPT" }));
    expect((opened.mock.calls[0]![0] as CustomEvent).detail).toEqual({ parent: "thr_parent", label: '"GPT review" (thr_codex)' });
    window.removeEventListener("cloudroom:connect-codex", opened);
  });

  it("uses the child's harness, not the error text, to pick the login", () => {
    harness.providerId = "acp-cursor";
    renderFailed(CODEX_401, "thr_cursor");
    expect(screen.getByRole("button", { name: "Sign in to Cursor" })).toBeTruthy();
    cleanup();
    harness.providerId = "pi";
    renderFailed(CODEX_401, "thr_pi");
    expect(screen.queryByText(/^Sign in to /)).toBeNull();
  });
});
