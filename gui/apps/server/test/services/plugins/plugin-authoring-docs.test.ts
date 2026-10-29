import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const GUIDE_URL = new URL(
  "../../../../../plugins/bb-guide/skills/plugin-authoring/references/backend-machines.md",
  import.meta.url,
);

describe("plugin-authoring skill", () => {
  it("typechecks the machine provider guide example against the public SDK", () => {
    const source = readFileSync(GUIDE_URL, "utf8").match(
      /```ts\n([\s\S]*?)```/u,
    )?.[1];
    expect(source).toBeDefined();
    const filename = fileURLToPath(
      new URL("./machine-guide-example.ts", import.meta.url),
    );
    const options: ts.CompilerOptions = {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    };
    const host = ts.createCompilerHost(options);
    const readSource = host.getSourceFile.bind(host);
    host.getSourceFile = (
      file,
      languageVersion,
      onError,
      shouldCreateNewSourceFile,
    ) =>
      file === filename
        ? ts.createSourceFile(filename, source!, languageVersion)
        : readSource(file, languageVersion, onError, shouldCreateNewSourceFile);
    const program = ts.createProgram([filename], options, host);
    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        ),
    ).toEqual([]);
  });
});
