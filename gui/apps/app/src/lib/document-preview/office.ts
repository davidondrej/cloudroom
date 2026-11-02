import {
  listZip,
  MAX_UNPACKED_BYTES,
  readZipEntry,
  type ZipEntry,
} from "./archive";

export interface DocumentPart {
  name: string;
  text: string;
}

interface Relationship {
  target: string;
  type: string;
  external: boolean;
}

interface OfficePackage {
  xml(path: string): Promise<Document | null>;
  rels(path: string): Promise<Map<string, Relationship>>;
  mainPart(fallback: string): Promise<string>;
}

interface NumberFormat {
  kind: "date" | "percent" | "time";
  decimals: number;
  withTime: boolean;
}

interface Inline {
  text: string;
  bold: boolean;
  italic: boolean;
  raw?: boolean;
}

const MAX_SHEET_ROWS = 5000;
const MAX_OUTPUT_CHARS = 5_000_000;
const MAX_CELL_CHARS = 32_767;
const MAX_SHEET_COLUMNS = 100;
const MAX_SLIDES = 500;
const utf8 = new TextDecoder();
const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 22, 45, 46, 47]);
const TIME_FORMAT_IDS = new Set([18, 19, 20, 21]);
const LINK_PATTERN = /^(https?:|mailto:)/iu;

function elements(parent: Element | null | undefined, name: string): Element[] {
  return parent
    ? [...parent.children].filter((el) => el.localName === name)
    : [];
}

function element(
  parent: Element | undefined,
  name: string,
): Element | undefined {
  return elements(parent, name)[0];
}

function descendants(
  parent: Document | Element | null | undefined,
  name: string,
): Element[] {
  return parent ? [...parent.getElementsByTagNameNS("*", name)] : [];
}

function attribute(
  el: Element | null | undefined,
  name: string,
): string | null {
  for (const attr of el?.attributes ?? []) {
    if (attr.localName === name) return attr.value;
  }
  return null;
}

function relationshipId(el: Element | undefined): string {
  for (const attr of el?.attributes ?? []) {
    if (attr.localName === "id" && attr.namespaceURI?.includes("relationships"))
      return attr.value;
  }
  return "";
}

function isOn(el: Element | undefined): boolean {
  if (!el) return false;
  const value = attribute(el, "val");
  return value === null || !["0", "false", "off", "none"].includes(value);
}

function resolvePath(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

export function openOfficePackage(bytes: Uint8Array): OfficePackage {
  const entries = new Map<string, ZipEntry>(
    listZip(bytes).map((entry) => [entry.name, entry]),
  );
  let unpackedBytes = 0;
  const xml = async (path: string): Promise<Document | null> => {
    const entry = entries.get(path);
    if (!entry) return null;
    const data = await readZipEntry(bytes, entry);
    unpackedBytes += data.byteLength;
    if (unpackedBytes > MAX_UNPACKED_BYTES) {
      throw new Error("File is too large to preview.");
    }
    const document = new DOMParser().parseFromString(
      utf8.decode(data),
      "application/xml",
    );
    if (document.getElementsByTagName("parsererror").length > 0) {
      throw new Error(`Broken XML in ${path}.`);
    }
    return document;
  };
  const rels = async (path: string): Promise<Map<string, Relationship>> => {
    const slash = path.lastIndexOf("/");
    const relsPath = `${path.slice(0, slash + 1)}_rels/${path.slice(slash + 1)}.rels`;
    const result = new Map<string, Relationship>();
    for (const rel of descendants(await xml(relsPath), "Relationship")) {
      const id = attribute(rel, "Id");
      const target = attribute(rel, "Target");
      if (!id || target === null) continue;
      const external = attribute(rel, "TargetMode") === "External";
      result.set(id, {
        target: external ? target : resolvePath(path, target),
        type: attribute(rel, "Type") ?? "",
        external,
      });
    }
    return result;
  };
  const mainPart = async (fallback: string): Promise<string> => {
    for (const rel of (await rels("")).values()) {
      if (rel.type.endsWith("/officeDocument") && entries.has(rel.target))
        return rel.target;
    }
    return fallback;
  };
  return { xml, rels, mainPart };
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_~[\]<>|]/gu, "\\$&");
}

function escapeLineStart(text: string): string {
  return /^(#{1,6}\s|[-+]\s|\d+[.)]\s)/u.test(text) ? `\\${text}` : text;
}

function renderInlines(inlines: Inline[]): string {
  const merged: Inline[] = [];
  for (const inline of inlines) {
    const last = merged.at(-1);
    if (
      last &&
      !last.raw &&
      !inline.raw &&
      last.bold === inline.bold &&
      last.italic === inline.italic
    ) {
      last.text += inline.text;
    } else {
      merged.push({ ...inline });
    }
  }
  return merged
    .map(({ text, bold, italic, raw }) => {
      if (raw) return text;
      const core = text.trim();
      if (!core || (!bold && !italic)) return escapeMarkdown(text);
      const mark = bold && italic ? "***" : bold ? "**" : "*";
      const lead = text.slice(0, text.indexOf(core));
      const trail = text.slice(text.indexOf(core) + core.length);
      return `${lead}${mark}${escapeMarkdown(core)}${mark}${trail}`;
    })
    .join("");
}

function markdownTable(rows: string[][]): string {
  const width = Math.max(0, ...rows.map((row) => row.length));
  if (width === 0) return "";
  const line = (row: string[]) =>
    `| ${Array.from({ length: width }, (_, index) => row[index] || " ").join(" | ")} |`;
  const [header = [], ...body] = rows;
  return [line(header), `|${" --- |".repeat(width)}`, ...body.map(line)].join(
    "\n",
  );
}

function joinBlocks(blocks: { text: string; list: boolean }[]): string {
  return blocks
    .map((block, index) =>
      index === 0
        ? block.text
        : `${block.list && blocks[index - 1]?.list ? "\n" : "\n\n"}${block.text}`,
    )
    .join("");
}

function csvField(value: string): string {
  return /[",\r\n]|^\s|\s$/u.test(value)
    ? `"${value.replace(/"/gu, '""')}"`
    : value;
}

function columnIndex(reference: string): number {
  let index = 0;
  for (const character of reference.toUpperCase()) {
    const code = character.charCodeAt(0);
    if (code < 65 || code > 90) break;
    index = index * 26 + code - 64;
  }
  return index - 1;
}

function classifyNumberFormat(
  id: number,
  code: string | undefined,
): NumberFormat | null {
  if (id === 9 || id === 10)
    return { kind: "percent", decimals: id === 10 ? 2 : 0, withTime: false };
  if (DATE_FORMAT_IDS.has(id))
    return { kind: "date", decimals: 0, withTime: id === 22 };
  if (TIME_FORMAT_IDS.has(id))
    return { kind: "time", decimals: 0, withTime: true };
  if (!code) return null;
  const plain = code.replace(/"[^"]*"|\\.|\[(?![hms]+\])[^\]]*\]/giu, "");
  if (plain.includes("%")) {
    return {
      kind: "percent",
      decimals: /\.(0+)/u.exec(plain)?.[1]?.length ?? 0,
      withTime: false,
    };
  }
  const hasTime = /[hs]/iu.test(plain);
  const hasDate = /[dy]/iu.test(plain) || (/m/iu.test(plain) && !hasTime);
  if (hasDate) return { kind: "date", decimals: 0, withTime: hasTime };
  if (hasTime) return { kind: "time", decimals: 0, withTime: true };
  return null;
}

function formatSerialDate(
  serial: number,
  date1904: boolean,
  format: NumberFormat,
): string {
  const days = serial + (date1904 ? 1462 : 0) - 25569;
  const iso = new Date(Math.round(days * 86400) * 1000).toISOString();
  const date = iso.slice(0, 10);
  const time = iso.slice(11, iso.endsWith(":00.000Z") ? 16 : 19);
  if (format.kind === "time") return time;
  return format.withTime ? `${date} ${time}` : date;
}

function formatNumber(
  raw: string,
  format: NumberFormat | null,
  date1904: boolean,
): string {
  const value = Number(raw);
  if (!Number.isFinite(value)) return raw;
  if (format?.kind === "percent")
    return `${(value * 100).toFixed(format.decimals)}%`;
  if (format) return formatSerialDate(value, date1904, format);
  return String(Number(value.toPrecision(15)));
}

function cellText(el: Element | undefined): string {
  return descendants(el, "t")
    .filter((t) => t.parentElement?.localName !== "rPh")
    .map((t) => t.textContent ?? "")
    .join("");
}

export async function convertWorkbook(
  bytes: Uint8Array,
): Promise<DocumentPart[]> {
  const pkg = openOfficePackage(bytes);
  const workbookPath = await pkg.mainPart("xl/workbook.xml");
  const workbook = await pkg.xml(workbookPath);
  if (!workbook) throw new Error("Missing workbook.");
  const rels = await pkg.rels(workbookPath);
  const relTarget = (type: string, fallback: string) =>
    [...rels.values()].find((rel) => rel.type.endsWith(type))?.target ??
    fallback;
  const sharedStrings = descendants(
    await pkg.xml(relTarget("/sharedStrings", "xl/sharedStrings.xml")),
    "si",
  ).map(cellText);
  const styles = await pkg.xml(relTarget("/styles", "xl/styles.xml"));
  const customFormats = new Map(
    descendants(styles, "numFmt").map((format) => [
      Number(attribute(format, "numFmtId")),
      attribute(format, "formatCode") ?? "",
    ]),
  );
  const cellFormats = elements(descendants(styles, "cellXfs")[0], "xf").map(
    (xf) => {
      const id = Number(attribute(xf, "numFmtId") ?? 0);
      return classifyNumberFormat(id, customFormats.get(id));
    },
  );
  const date1904 = ["1", "true"].includes(
    attribute(descendants(workbook, "workbookPr")[0], "date1904") ?? "",
  );

  const parts: DocumentPart[] = [];
  let outputChars = 0;
  for (const sheet of descendants(workbook, "sheet")) {
    if (outputChars >= MAX_OUTPUT_CHARS) break;
    const rel = rels.get(relationshipId(sheet));
    if (!rel || !rel.type.endsWith("/worksheet")) continue;
    const document = await pkg.xml(rel.target);
    const rows: string[][] = [];
    for (const row of descendants(document, "row")) {
      const rowNumber = Number(attribute(row, "r")) || rows.length + 1;
      if (rowNumber > MAX_SHEET_ROWS || outputChars >= MAX_OUTPUT_CHARS) break;
      while (rows.length < rowNumber - 1) rows.push([]);
      const cells: string[] = [];
      for (const cell of elements(row, "c")) {
        const reference = attribute(cell, "r");
        const column = reference ? columnIndex(reference) : cells.length;
        if (column < 0 || column >= MAX_SHEET_COLUMNS) continue;
        while (cells.length < column) cells.push("");
        const type = attribute(cell, "t");
        const raw = element(cell, "v")?.textContent ?? "";
        const formula = element(cell, "f")?.textContent ?? "";
        const value =
          type === "s"
            ? (sharedStrings[Number(raw)] ?? "")
            : type === "inlineStr"
              ? cellText(element(cell, "is"))
              : type === "b"
                ? raw === "1"
                  ? "TRUE"
                  : "FALSE"
                : raw === ""
                  ? formula
                    ? `=${formula}`
                    : ""
                  : type === "str" || type === "e" || type === "d"
                    ? raw
                    : formatNumber(
                        raw,
                        cellFormats[Number(attribute(cell, "s") ?? 0)] ?? null,
                        date1904,
                      );
        cells[column] = value.slice(0, MAX_CELL_CHARS);
      }
      rows[rowNumber - 1] = cells;
      outputChars += cells.reduce((total, cell) => total + cell.length + 1, 1);
    }
    while (rows.length > 0 && (rows.at(-1) ?? []).every((cell) => cell === ""))
      rows.pop();
    parts.push({
      name: attribute(sheet, "name") ?? `Sheet ${parts.length + 1}`,
      text: rows.map((row) => row.map(csvField).join(",")).join("\n"),
    });
  }
  if (parts.length === 0) throw new Error("No sheets.");
  return parts;
}

function wordInlines(
  parent: Element,
  rels: Map<string, Relationship>,
  inlines: Inline[] = [],
): Inline[] {
  for (const child of parent.children) {
    const name = child.localName;
    if (name === "r") {
      const props = element(child, "rPr");
      const bold = isOn(element(props, "b"));
      const italic = isOn(element(props, "i"));
      for (const part of child.children) {
        const text =
          part.localName === "t"
            ? (part.textContent ?? "")
            : part.localName === "tab"
              ? " "
              : part.localName === "br" || part.localName === "cr"
                ? "\n"
                : part.localName === "noBreakHyphen"
                  ? "-"
                  : "";
        if (text) inlines.push({ text, bold, italic });
      }
    } else if (name === "hyperlink") {
      const rel = rels.get(relationshipId(child));
      const inner = renderInlines(wordInlines(child, rels));
      if (rel?.external && LINK_PATTERN.test(rel.target) && inner.trim()) {
        inlines.push({
          text: `[${inner}](${rel.target.replace(/[()<> ]/gu, encodeURIComponent)})`,
          bold: false,
          italic: false,
          raw: true,
        });
      } else {
        wordInlines(child, rels, inlines);
      }
    } else if (!["pPr", "rPr", "del", "moveFrom"].includes(name)) {
      wordInlines(child, rels, inlines);
    }
  }
  return inlines;
}

export async function convertWordDocument(
  bytes: Uint8Array,
): Promise<{ markdown: string; words: number }> {
  const pkg = openOfficePackage(bytes);
  const documentPath = await pkg.mainPart("word/document.xml");
  const document = await pkg.xml(documentPath);
  const body = descendants(document, "body")[0];
  if (!body) throw new Error("Missing document body.");
  const rels = await pkg.rels(documentPath);
  const styleNames = new Map(
    descendants(await pkg.xml("word/styles.xml"), "style").map((style) => [
      attribute(style, "styleId") ?? "",
      (attribute(element(style, "name"), "val") ?? "").toLowerCase(),
    ]),
  );
  const numbering = await pkg.xml("word/numbering.xml");
  const abstractFormats = new Map(
    descendants(numbering, "abstractNum").map((abstract) => [
      attribute(abstract, "abstractNumId") ?? "",
      new Map(
        elements(abstract, "lvl").map((level) => [
          attribute(level, "ilvl") ?? "0",
          attribute(element(level, "numFmt"), "val") ?? "bullet",
        ]),
      ),
    ]),
  );
  const listFormats = new Map(
    elements(numbering?.documentElement, "num").map((num) => [
      attribute(num, "numId") ?? "",
      abstractFormats.get(
        attribute(element(num, "abstractNumId"), "val") ?? "",
      ),
    ]),
  );

  let words = 0;
  const paragraphText = (paragraph: Element) => {
    words += descendants(paragraph, "t")
      .map((t) => t.textContent ?? "")
      .join("")
      .split(/\s+/u)
      .filter(Boolean).length;
    return renderInlines(wordInlines(paragraph, rels));
  };
  const blocks: { text: string; list: boolean }[] = [];
  const addBlock = (el: Element) => {
    if (el.localName === "sdt") {
      for (const child of element(el, "sdtContent")?.children ?? [])
        addBlock(child);
      return;
    }
    if (el.localName === "tbl") {
      const rows = elements(el, "tr").map((row) =>
        elements(row, "tc").flatMap((cell) => {
          const text = elements(cell, "p")
            .map(paragraphText)
            .join(" ")
            .replace(/\s*\n\s*/gu, " ")
            .trim();
          const span = Number(
            attribute(element(element(cell, "tcPr"), "gridSpan"), "val") ?? 1,
          );
          return [
            text,
            ...Array.from({ length: Math.max(0, span - 1) }, () => ""),
          ];
        }),
      );
      const table = markdownTable(rows);
      if (table) blocks.push({ text: table, list: false });
      return;
    }
    if (el.localName !== "p") return;
    const props = element(el, "pPr");
    const style =
      styleNames.get(attribute(element(props, "pStyle"), "val") ?? "") ?? "";
    const text = paragraphText(el).trim();
    if (!text) return;
    const outline = attribute(element(props, "outlineLvl"), "val");
    const heading =
      style === "title"
        ? 1
        : /^heading (\d)/u.exec(style)?.[1]
          ? Number(/^heading (\d)/u.exec(style)?.[1])
          : outline !== null
            ? Number(outline) + 1
            : 0;
    if (heading > 0) {
      blocks.push({
        text: `${"#".repeat(Math.min(heading, 6))} ${text.replace(/\s*\n\s*/gu, " ")}`,
        list: false,
      });
      return;
    }
    const numberProps = element(props, "numPr");
    const styleList = /^list (bullet|number)(?: (\d))?/u.exec(style);
    if (numberProps || styleList) {
      const level = numberProps
        ? Number(attribute(element(numberProps, "ilvl"), "val") ?? 0)
        : Math.max(0, Number(styleList?.[2] ?? 1) - 1);
      const format = numberProps
        ? listFormats
            .get(attribute(element(numberProps, "numId"), "val") ?? "")
            ?.get(String(level))
        : styleList?.[1] === "number"
          ? "decimal"
          : "bullet";
      const marker =
        format && format !== "bullet" && format !== "none" ? "1." : "-";
      blocks.push({
        text: `${"  ".repeat(level)}${marker} ${text.replace(/\s*\n\s*/gu, " ")}`,
        list: true,
      });
      return;
    }
    blocks.push({
      text: escapeLineStart(text).replace(/\n/gu, "  \n"),
      list: false,
    });
  };
  for (const child of body.children) addBlock(child);
  return { markdown: joinBlocks(blocks), words };
}

function drawingText(paragraph: Element): string {
  const inlines: Inline[] = [];
  for (const child of paragraph.children) {
    if (child.localName === "br") {
      inlines.push({ text: " ", bold: false, italic: false });
      continue;
    }
    if (child.localName !== "r" && child.localName !== "fld") continue;
    const props = element(child, "rPr");
    inlines.push({
      text: element(child, "t")?.textContent ?? "",
      bold: ["1", "true"].includes(attribute(props, "b") ?? ""),
      italic: ["1", "true"].includes(attribute(props, "i") ?? ""),
    });
  }
  return renderInlines(inlines).trim();
}

function drawingParagraphs(
  parent: Element | undefined,
): { text: string; level: number }[] {
  return elements(parent, "p")
    .map((paragraph) => ({
      text: drawingText(paragraph),
      level: Number(attribute(element(paragraph, "pPr"), "lvl") ?? 0),
    }))
    .filter((paragraph) => paragraph.text);
}

export async function convertPresentation(
  bytes: Uint8Array,
): Promise<{ markdown: string; slides: number }> {
  const pkg = openOfficePackage(bytes);
  const presentationPath = await pkg.mainPart("ppt/presentation.xml");
  const presentation = await pkg.xml(presentationPath);
  if (!presentation) throw new Error("Missing presentation.");
  const rels = await pkg.rels(presentationPath);
  const slidePaths = descendants(presentation, "sldId")
    .map((slide) => rels.get(relationshipId(slide))?.target)
    .filter((path): path is string => Boolean(path))
    .slice(0, MAX_SLIDES);

  const sections: string[] = [];
  for (const [index, slidePath] of slidePaths.entries()) {
    const slide = await pkg.xml(slidePath);
    if (!slide) continue;
    let title = "";
    const blocks: { text: string; list: boolean }[] = [];
    for (const shape of descendants(slide, "sp")) {
      const placeholder = descendants(element(shape, "nvSpPr"), "ph")[0];
      const type = placeholder
        ? (attribute(placeholder, "type") ?? "body")
        : null;
      const paragraphs = drawingParagraphs(element(shape, "txBody"));
      if (paragraphs.length === 0) continue;
      if (type === "title" || type === "ctrTitle") {
        title = paragraphs.map((paragraph) => paragraph.text).join(" ");
      } else if (type === "body" || type === "obj") {
        for (const paragraph of paragraphs) {
          blocks.push({
            text: `${"  ".repeat(paragraph.level)}- ${paragraph.text}`,
            list: true,
          });
        }
      } else if (type !== "sldNum" && type !== "dt" && type !== "ftr") {
        for (const paragraph of paragraphs) {
          blocks.push({ text: escapeLineStart(paragraph.text), list: false });
        }
      }
    }
    for (const table of descendants(slide, "tbl")) {
      const markdown = markdownTable(
        elements(table, "tr").map((row) =>
          elements(row, "tc").map((cell) =>
            drawingParagraphs(element(cell, "txBody"))
              .map((paragraph) => paragraph.text)
              .join(" "),
          ),
        ),
      );
      if (markdown) blocks.push({ text: markdown, list: false });
    }
    const notesRel = [...(await pkg.rels(slidePath)).values()].find((rel) =>
      rel.type.endsWith("/notesSlide"),
    );
    const notes = notesRel ? await pkg.xml(notesRel.target) : null;
    const noteLines = descendants(notes, "sp")
      .filter(
        (shape) =>
          attribute(descendants(element(shape, "nvSpPr"), "ph")[0], "type") ===
          "body",
      )
      .flatMap((shape) =>
        drawingParagraphs(element(shape, "txBody")).map(
          (paragraph) => paragraph.text,
        ),
      );
    if (noteLines.length > 0) {
      blocks.push({
        text: noteLines
          .map(
            (line, lineIndex) => `> ${lineIndex === 0 ? "Notes: " : ""}${line}`,
          )
          .join("\n>\n"),
        list: false,
      });
    }
    const hidden =
      attribute(slide.documentElement, "show") === "0" ? " (hidden)" : "";
    const heading = `### Slide ${index + 1}${title ? ` · ${title.replace(/\s*\n\s*/gu, " ")}` : ""}${hidden}`;
    sections.push(joinBlocks([{ text: heading, list: false }, ...blocks]));
  }
  if (slidePaths.length === 0) throw new Error("No slides.");
  return { markdown: sections.join("\n\n"), slides: slidePaths.length };
}
