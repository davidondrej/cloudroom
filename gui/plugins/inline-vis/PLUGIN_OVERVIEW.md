See an agent's chart, demo, report, or Markdown document in the conversation without opening a side panel. The agent writes an HTML or Markdown file to the workspace or the thread's storage directory. The plugin shows that file inside the assistant message.

## What you get

- An HTML page that reads as part of the reply: borderless, in the app's theme, and as tall as its content (up to 2000 pixels). The agent can cap the height.
- A formatted Markdown document, 224 pixels tall by default.
- An action that opens workspace source files in the workspace viewer. Thread-storage previews omit this action.
- A clear inline error when the file is missing, too large, or unsupported.

## How it works

The agent emits a message directive that names a source-relative `.html`, `.htm`, `.md`, or `.markdown` file. Omitting `source` defaults to the workspace, and explicit `source="workspace"` is equivalent:

```text
::inline-vis{file="charts/out.html" height="480"}
::inline-vis{file="reports/summary.md"}
```

Read-only artifacts in the thread's storage directory can be rendered without resolving the workspace:

```text
::inline-vis{source="thread-storage" file="reports/result.html"}
```

The plugin confirms the file exists in the selected source before it renders. Files must be UTF-8 text with a maximum size of 5 MiB. Relative assets next to HTML files load as usual.

HTML runs in a sandboxed iframe with an opaque origin. Scripts in the file cannot read the Cloudroom page, its cookies, or its storage. Links open in the user's browser. Markdown uses Cloudroom's renderer with raw HTML disabled.

## For agents

The bundled `inline-vis` skill teaches the agent when to emit the directive and how to write the file. No account or external service is required.
