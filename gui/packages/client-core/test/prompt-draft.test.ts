import { describe, expect, it } from "vitest";
import type { PromptMentionResource } from "@cloudroom/domain";
import {
  appendMessageContextToDraft,
  appendQuoteAndAttachmentsToDraft,
  appendQuoteToDraftText,
  emptyPromptDraftState,
  findMessageContextLines,
  isPromptDraftEmpty,
  numberMessageContextInDraft,
  parsePromptDraftStorage,
  promptDraftToInput,
  promptInputToDraft,
  serializePromptDraftStorage,
} from "../src/prompt/prompt-draft.js";
import { splitMessageContextSegments } from "../src/prompt/message-context.js";

const AUTOMATION_COMMAND_RESOURCE: PromptMentionResource = {
  kind: "command",
  trigger: "/",
  name: "automation",
  source: "command",
  origin: "user",
  label: "automation",
  argumentHint: null,
};

describe("prompt draft helpers", () => {
  it("drops invalid legacy raw text drafts", () => {
    const parsed = parsePromptDraftStorage("Investigate flaky login redirect");
    expect(parsed).toEqual({
      text: "",
      mentions: [],
      attachments: [],
    });
  });

  it("parses structured drafts with attachments", () => {
    const parsed = parsePromptDraftStorage(
      JSON.stringify({
        text: "Review",
        attachments: [
          {
            type: "localImage",
            path: "/tmp/image.png",
            name: "image.png",
            sizeBytes: 12,
            mimeType: "image/png",
          },
        ],
      }),
    );

    expect(parsed).toEqual({
      text: "Review",
      mentions: [],
      attachments: [
        {
          type: "localImage",
          path: "/tmp/image.png",
          name: "image.png",
          sizeBytes: 12,
          mimeType: "image/png",
        },
      ],
    });
  });

  it("detects whether a draft has any submittable state", () => {
    expect(isPromptDraftEmpty(emptyPromptDraftState())).toBe(true);
    expect(
      isPromptDraftEmpty({
        text: "",
        mentions: [],
        attachments: [
          {
            type: "localFile",
            path: "/tmp/spec.md",
            name: "spec.md",
            sizeBytes: 42,
            mimeType: "text/markdown",
          },
        ],
      }),
    ).toBe(false);
  });

  it("maps draft text and attachments to prompt input list", () => {
    const input = promptDraftToInput({
      text: "  Ship this patch  ",
      mentions: [],
      attachments: [
        {
          type: "localImage",
          path: "/tmp/image.png",
          name: "image.png",
          sizeBytes: 32,
          mimeType: "image/png",
        },
        {
          type: "localFile",
          path: "/tmp/spec.md",
          name: "spec.md",
          sizeBytes: 42,
          mimeType: "text/markdown",
        },
      ],
    });

    expect(input).toEqual([
      { type: "text", text: "Ship this patch", mentions: [] },
      { type: "localImage", path: "/tmp/image.png" },
      {
        type: "localFile",
        path: "/tmp/spec.md",
        name: "spec.md",
        sizeBytes: 42,
        mimeType: "text/markdown",
      },
    ]);
  });

  it("expands automation command pills before mapping draft text to prompt input", () => {
    const input = promptDraftToInput({
      text: "/automation keep checking CI",
      mentions: [
        {
          start: 0,
          end: "/automation".length,
          resource: AUTOMATION_COMMAND_RESOURCE,
        },
      ],
      attachments: [],
    });

    expect(input).toEqual([
      {
        type: "text",
        text: "Create a new Cloudroom loop to keep checking CI",
        mentions: [],
      },
    ]);
  });

  it("keeps mention ranges correct after expanding an automation command pill", () => {
    const threadResource: PromptMentionResource = {
      kind: "thread",
      threadId: "thr_child",
      label: "Child thread",
    };
    const text = "/automation inspect @thread";
    const threadToken = "@thread";
    const threadStart = text.indexOf(threadToken);
    if (threadStart < 0) {
      throw new Error("Expected thread token in test text");
    }

    const input = promptDraftToInput({
      text,
      mentions: [
        {
          start: 0,
          end: "/automation".length,
          resource: AUTOMATION_COMMAND_RESOURCE,
        },
        {
          start: threadStart,
          end: threadStart + threadToken.length,
          resource: threadResource,
        },
      ],
      attachments: [],
    });

    expect(input).toEqual([
      {
        type: "text",
        text: "Create a new Cloudroom loop to inspect @thread",
        mentions: [
          {
            start: "Create a new Cloudroom loop to inspect ".length,
            end: "Create a new Cloudroom loop to inspect @thread".length,
            resource: threadResource,
          },
        ],
      },
    ]);
  });

  it("leaves literal automation text unchanged when it is not a command pill", () => {
    const input = promptDraftToInput({
      text: "/automation keep checking CI",
      mentions: [],
      attachments: [],
    });

    expect(input).toEqual([
      { type: "text", text: "/automation keep checking CI", mentions: [] },
    ]);
  });

  it("omits zero-size localFile size when mapping draft attachments to prompt input", () => {
    const input = promptDraftToInput({
      text: "",
      mentions: [],
      attachments: [
        {
          type: "localFile",
          path: "uploads/spec.md",
          name: "spec.md",
          sizeBytes: 0,
        },
      ],
    });

    expect(input).toEqual([
      {
        type: "localFile",
        path: "uploads/spec.md",
        name: "spec.md",
      },
    ]);
  });

  it("keeps visible mention ranges when trailing trim clips mention whitespace", () => {
    const resource: PromptMentionResource = {
      kind: "thread",
      threadId: "thr_parent",
      label: "Prompt UX thread",
    };
    const text = "  Ask @manager   ";
    const token = "@manager";
    const start = text.indexOf(token);
    if (start < 0) {
      throw new Error("Expected mention token in test text");
    }

    const input = promptDraftToInput({
      text,
      mentions: [
        {
          start,
          end: text.length,
          resource,
        },
      ],
      attachments: [],
    });

    expect(input).toEqual([
      {
        type: "text",
        text: "Ask @manager",
        mentions: [
          {
            start: "Ask ".length,
            end: "Ask @manager".length,
            resource,
          },
        ],
      },
    ]);
  });

  it("maps prompt input back to an editable draft", () => {
    const draft = promptInputToDraft([
      { type: "text", text: "Investigate", mentions: [] },
      { type: "image", url: "https://example.com/image.png" },
      { type: "localImage", path: "/tmp/screenshot.png" },
      {
        type: "localFile",
        path: "/tmp/spec.md",
        name: "spec.md",
        sizeBytes: 42,
        mimeType: "text/markdown",
      },
    ]);

    expect(draft).toEqual({
      text: "Investigate",
      mentions: [],
      attachments: [
        {
          type: "localImage",
          path: "/tmp/screenshot.png",
          name: "screenshot.png",
          sizeBytes: 0,
        },
        {
          type: "localFile",
          path: "/tmp/spec.md",
          name: "spec.md",
          sizeBytes: 42,
          mimeType: "text/markdown",
        },
      ],
    });
  });
});

describe("appendQuoteToDraftText", () => {
  it("appends a one-line quote to an empty draft with a trailing newline", () => {
    const next = appendQuoteToDraftText(
      emptyPromptDraftState(),
      "  hello world  ",
    );
    expect(next.text).toBe("> hello world\n");
  });

  it("prefixes each line of a multi-line quote and prefixes blank lines as `>`", () => {
    const next = appendQuoteToDraftText(
      emptyPromptDraftState(),
      "para one\n\npara two",
    );
    expect(next.text).toBe("> para one\n>\n> para two\n");
  });

  it("appends to existing text separated by a newline", () => {
    const base = { text: "existing reply", mentions: [], attachments: [] };
    const next = appendQuoteToDraftText(base, "quoted");
    expect(next.text).toBe("existing reply\n> quoted\n");
  });

  it("ignores an empty or whitespace-only quote", () => {
    const base = emptyPromptDraftState();
    expect(appendQuoteToDraftText(base, "")).toBe(base);
    expect(appendQuoteToDraftText(base, "   \n  ")).toBe(base);
  });

  it("leaves existing mention offsets byte-for-byte unchanged (appends to the end)", () => {
    const resource: PromptMentionResource = {
      kind: "thread",
      threadId: "thr_parent",
      label: "Prompt UX thread",
    };
    const text = "Ask @manager now";
    const start = text.indexOf("@manager");
    const mention = { start, end: start + "@manager".length, resource };
    const base = { text, mentions: [mention], attachments: [] };

    const next = appendQuoteToDraftText(base, "context");

    expect(next.mentions).toEqual([mention]);
    expect(next.text.startsWith(text)).toBe(true);
  });
});

describe("appendQuoteAndAttachmentsToDraft", () => {
  it("appends a quote and merges new attachments", () => {
    const next = appendQuoteAndAttachmentsToDraft(
      emptyPromptDraftState(),
      "review this",
      [
        {
          type: "localImage",
          path: "uploads/screenshot.png",
          name: "screenshot.png",
          sizeBytes: 0,
        },
      ],
    );

    expect(next).toEqual({
      text: "> review this\n",
      mentions: [],
      attachments: [
        {
          type: "localImage",
          path: "uploads/screenshot.png",
          name: "screenshot.png",
          sizeBytes: 0,
        },
      ],
    });
  });

  it("adds attachments even when there is no quote text", () => {
    const next = appendQuoteAndAttachmentsToDraft(emptyPromptDraftState(), "", [
      {
        type: "localFile",
        path: "uploads/spec.md",
        name: "spec.md",
        sizeBytes: 0,
      },
    ]);

    expect(next).toEqual({
      text: "",
      mentions: [],
      attachments: [
        {
          type: "localFile",
          path: "uploads/spec.md",
          name: "spec.md",
          sizeBytes: 0,
        },
      ],
    });
  });

  it("dedupes attachments by path", () => {
    const attachment = {
      type: "localFile" as const,
      path: "uploads/spec.md",
      name: "spec.md",
      sizeBytes: 0,
    };
    const base = {
      text: "",
      mentions: [],
      attachments: [attachment],
    };

    expect(appendQuoteAndAttachmentsToDraft(base, "", [attachment])).toBe(base);
  });
});

describe("message context chips", () => {
  it("preserves the message number on submit and restores it when editing", () => {
    const withContext = appendMessageContextToDraft(
      emptyPromptDraftState(),
      "Danny Li (Morse): affiliate offer, wants our terms.",
      465,
    );
    const threadResource: PromptMentionResource = {
      kind: "thread",
      threadId: "thr_partner",
      label: "Partner thread",
    };
    const replySuffix = "Check @partner before sending";
    const draftText = `${withContext.text}${replySuffix}`;
    const mentionStart = draftText.indexOf("@partner");
    const input = promptDraftToInput({
      ...withContext,
      text: draftText,
      mentions: [
        {
          start: mentionStart,
          end: mentionStart + "@partner".length,
          resource: threadResource,
        },
      ],
    });

    expect(input).toEqual([
      {
        type: "text",
        text: '<context message="#465">\nDanny Li (Morse): affiliate offer, wants our terms.\n</context>\nCheck @partner before sending',
        mentions: [
          {
            start:
              '<context message="#465">\nDanny Li (Morse): affiliate offer, wants our terms.\n</context>\nCheck '
                .length,
            end:
              '<context message="#465">\nDanny Li (Morse): affiliate offer, wants our terms.\n</context>\nCheck @partner'
                .length,
            resource: threadResource,
          },
        ],
      },
    ]);

    const restored = promptInputToDraft(input);
    expect(restored).toEqual({
      text: "<context> [message #465 - 8 words] </context>\nCheck @partner before sending",
      mentions: [
        {
          start: "<context> [message #465 - 8 words] </context>\nCheck ".length,
          end: "<context> [message #465 - 8 words] </context>\nCheck @partner"
            .length,
          resource: threadResource,
        },
      ],
      attachments: [],
      contexts: [
        {
          label: "[message #465 - 8 words]",
          text: "Danny Li (Morse): affiliate offer, wants our terms.",
        },
      ],
    });
  });

  it("omits message attribute when unnumbered", () => {
    const withContext = appendMessageContextToDraft(
      emptyPromptDraftState(),
      "Run npm install first.",
      null,
    );
    expect(promptDraftToInput(withContext)).toEqual([
      {
        type: "text",
        text: "<context>\nRun npm install first.\n</context>",
        mentions: [],
      },
    ]);
  });

  it("splits numbered, legacy, multiple, and nested context blocks with exact offsets", () => {
    const nested = [
      '<context message="#12">',
      '<context message="#4">',
      "inner quote",
      "</context>",
      "outer reply",
      "</context>",
      "Follow up",
    ].join("\n");
    expect(splitMessageContextSegments(nested)).toEqual([
      {
        kind: "context",
        messageNumber: 12,
        text: '<context message="#4">\ninner quote\n</context>\nouter reply',
        start: 0,
        end: nested.lastIndexOf("</context>") + "</context>".length,
        bodyStart: '<context message="#12">\n'.length,
        bodyEnd: nested.lastIndexOf("\n</context>"),
      },
      {
        kind: "text",
        text: "Follow up",
        start: nested.indexOf("Follow up"),
        end: nested.length,
      },
    ]);

    const multi = [
      "<context>",
      "First snippet",
      "</context>",
      '<context message="#8">',
      "Second snippet",
      "</context>",
      "Compare both",
    ].join("\n");
    expect(
      splitMessageContextSegments(multi).map((segment) => ({
        kind: segment.kind,
        text: segment.text,
        ...(segment.kind === "context"
          ? { messageNumber: segment.messageNumber }
          : {}),
      })),
    ).toEqual([
      { kind: "context", text: "First snippet", messageNumber: null },
      { kind: "context", text: "Second snippet", messageNumber: 8 },
      { kind: "text", text: "Compare both" },
    ]);
  });

  it("ignores context tags inside fenced code blocks or unclosed tags", () => {
    const fenced = "```xml\n<context>\nexample\n</context>\n```";
    expect(splitMessageContextSegments(fenced)).toEqual([
      { kind: "text", text: fenced, start: 0, end: fenced.length },
    ]);

    const unclosed = "<context>\nstill typing";
    expect(splitMessageContextSegments(unclosed)).toEqual([
      { kind: "text", text: unclosed, start: 0, end: unclosed.length },
    ]);
  });

  it("ignores context tags inside fenced code blocks within a quoted body and falls back on unclosed fences", () => {
    const withFencedClose = [
      '<context message="#9">',
      "Example:",
      "```xml",
      "</context>",
      "```",
      "still quoted",
      "</context>",
      "User reply",
    ].join("\n");
    expect(
      splitMessageContextSegments(withFencedClose).map((segment) => ({
        kind: segment.kind,
        text: segment.text,
      })),
    ).toEqual([
      {
        kind: "context",
        text: "Example:\n```xml\n</context>\n```\nstill quoted",
      },
      { kind: "text", text: "User reply" },
    ]);

    const withFencedOpen = [
      "<context>",
      "```xml",
      "<context>",
      "```",
      "</context>",
    ].join("\n");
    expect(
      splitMessageContextSegments(withFencedOpen).map((segment) => ({
        kind: segment.kind,
        text: segment.text,
      })),
    ).toEqual([{ kind: "context", text: "```xml\n<context>\n```" }]);

    const withUnclosedFence = [
      "<context>",
      "```ts",
      "const x = 1;",
      "</context>",
      "Follow up",
    ].join("\n");
    expect(
      splitMessageContextSegments(withUnclosedFence).map((segment) => ({
        kind: segment.kind,
        text: segment.text,
      })),
    ).toEqual([
      { kind: "context", text: "```ts\nconst x = 1;" },
      { kind: "text", text: "Follow up" },
    ]);
  });

  it("disambiguates colliding context labels, skips fenced placeholders, and avoids colliding with literal text", () => {
    const original = [
      "<context>",
      "alpha beta gamma",
      "</context>",
      "",
      "<context>",
      "one two three",
      "</context>",
      "",
      "```",
      "<context> [message - 3 words] </context>",
      "```",
      "",
      "Keep literal <context> [message - 3 words (2)] </context>",
    ].join("\n");

    const restored = promptInputToDraft([
      { type: "text", text: original, mentions: [] },
    ]);
    expect(restored.contexts).toHaveLength(2);
    expect(new Set(restored.contexts?.map((item) => item.label)).size).toBe(2);
    expect(findMessageContextLines(restored.text)).toHaveLength(3);

    const resubmitted = promptDraftToInput(restored);
    expect(resubmitted).toEqual([
      { type: "text", text: original, mentions: [] },
    ]);

    let drafted = appendMessageContextToDraft(
      emptyPromptDraftState(),
      "first three words",
      null,
    );
    drafted = appendMessageContextToDraft(drafted, "second three words", null);
    expect(drafted.contexts?.map((item) => item.label)).toEqual([
      "[message - 3 words]",
      "[message - 3 words (2)]",
    ]);
    const numbered = numberMessageContextInDraft(
      drafted,
      "second three words",
      14,
    );
    expect(numbered.contexts?.map((item) => item.label)).toEqual([
      "[message - 3 words]",
      "[message #14 - 3 words]",
    ]);
  });

  it("preserves leading whitespace and mentions inside context blocks across edit round-trips", () => {
    const teamResource: PromptMentionResource = {
      kind: "thread",
      threadId: "thr_team",
      label: "Team thread",
    };
    const outsideResource: PromptMentionResource = {
      kind: "thread",
      threadId: "thr_outside",
      label: "Outside thread",
    };
    const original = [
      '<context message="#4">',
      "  const owner = '@team';",
      "  return owner;",
      "</context>",
      "",
      "Ping @outside too",
    ].join("\n");
    const teamStart = original.indexOf("@team");
    const outsideStart = original.indexOf("@outside");
    const originalInput = [
      {
        type: "text" as const,
        text: original,
        mentions: [
          {
            start: teamStart,
            end: teamStart + "@team".length,
            resource: teamResource,
          },
          {
            start: outsideStart,
            end: outsideStart + "@outside".length,
            resource: outsideResource,
          },
        ],
      },
    ];

    const restored = promptInputToDraft(originalInput);
    expect(restored.contexts).toEqual([
      {
        label: "[message #4 - 6 words]",
        text: "  const owner = '@team';\n  return owner;",
        mentions: [
          {
            start: "  const owner = '".length,
            end: "  const owner = '@team".length,
            resource: teamResource,
          },
        ],
      },
    ]);

    const reparsed = parsePromptDraftStorage(
      serializePromptDraftStorage(restored),
    );
    expect(promptDraftToInput(reparsed)).toEqual(originalInput);
  });

  it("parses long logs with a trailing context block linearly", () => {
    const log = `${"log line without tags\n".repeat(16_000)}<context>\ntrailing quote\n</context>\nDone`;
    const startedAt = performance.now();
    const segments = splitMessageContextSegments(log);
    const elapsedMs = performance.now() - startedAt;

    expect(segments).toHaveLength(3);
    expect(segments[1]).toMatchObject({
      kind: "context",
      text: "trailing quote",
      messageNumber: null,
    });
    expect(elapsedMs).toBeLessThan(200);
  });
});
