export interface ArchiveEntry {
  name: string;
  size: number;
  isDirectory: boolean;
}

export interface ZipEntry extends ArchiveEntry {
  compressedSize: number;
  encrypted: boolean;
  method: number;
  offset: number;
}

interface InflateResult {
  bytes: Uint8Array;
  truncated: boolean;
}

export const MAX_UNPACKED_BYTES = 50 * 1024 * 1024;
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP_ENTRY_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const MAX_U32 = 0xffffffff;
const utf8 = new TextDecoder();

export async function inflate(
  bytes: Uint8Array,
  format: CompressionFormat,
  { allowTruncation = false } = {},
): Promise<InflateResult> {
  const reader = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(bytes as Uint8Array<ArrayBuffer>);
      controller.close();
    },
  })
    .pipeThrough(new DecompressionStream(format))
    .getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > MAX_UNPACKED_BYTES) {
        if (!allowTruncation) throw new Error("File is too large to preview.");
        chunks.push(value.subarray(0, MAX_UNPACKED_BYTES - total));
        total = MAX_UNPACKED_BYTES;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: result, truncated };
}

function findZipEnd(view: DataView): number {
  const last = view.byteLength - 22;
  for (let offset = last; offset >= Math.max(0, last - 0xffff); offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_END_SIGNATURE) return offset;
  }
  throw new Error("Not a ZIP file.");
}

export function listZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findZipEnd(view);
  let count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  if (
    (count === 0xffff || offset === MAX_U32) &&
    end >= 20 &&
    view.getUint32(end - 20, true) === ZIP64_LOCATOR_SIGNATURE
  ) {
    const end64 = Number(view.getBigUint64(end - 12, true));
    count = Number(view.getBigUint64(end64 + 32, true));
    offset = Number(view.getBigUint64(end64 + 48, true));
  }
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(offset, true) !== ZIP_ENTRY_SIGNATURE) {
      throw new Error("Broken ZIP file.");
    }
    const flags = view.getUint16(offset + 8, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameStart = offset + 46;
    const name = utf8.decode(bytes.subarray(nameStart, nameStart + nameLength));
    const sizes = [
      view.getUint32(offset + 24, true),
      view.getUint32(offset + 20, true),
      view.getUint32(offset + 42, true),
    ];
    readZip64Sizes(view, nameStart + nameLength, extraLength, sizes);
    entries.push({
      name,
      size: sizes[0] ?? 0,
      compressedSize: sizes[1] ?? 0,
      offset: sizes[2] ?? 0,
      method: view.getUint16(offset + 10, true),
      encrypted: (flags & 1) === 1,
      isDirectory: name.endsWith("/"),
    });
    offset = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readZip64Sizes(
  view: DataView,
  start: number,
  length: number,
  sizes: number[],
): void {
  for (let offset = start; offset + 4 <= start + length;) {
    const id = view.getUint16(offset, true);
    const size = view.getUint16(offset + 2, true);
    if (id === 1) {
      let field = offset + 4;
      for (let index = 0; index < sizes.length; index += 1) {
        if (sizes[index] !== MAX_U32 || field + 8 > offset + 4 + size) continue;
        sizes[index] = Number(view.getBigUint64(field, true));
        field += 8;
      }
      return;
    }
    offset += 4 + size;
  }
}

export async function readZipEntry(
  bytes: Uint8Array,
  entry: ZipEntry,
): Promise<Uint8Array> {
  if (entry.encrypted) throw new Error("Encrypted ZIP entry.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(entry.offset, true) !== ZIP_LOCAL_SIGNATURE) {
    throw new Error("Broken ZIP file.");
  }
  const start =
    entry.offset +
    30 +
    view.getUint16(entry.offset + 26, true) +
    view.getUint16(entry.offset + 28, true);
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return (await inflate(data, "deflate-raw")).bytes;
  throw new Error("Unsupported ZIP compression.");
}

function readTarString(
  bytes: Uint8Array,
  start: number,
  length: number,
): string {
  const field = bytes.subarray(start, start + length);
  const end = field.indexOf(0);
  return utf8.decode(end === -1 ? field : field.subarray(0, end));
}

function readPaxPath(bytes: Uint8Array): string | null {
  for (const record of utf8.decode(bytes).split("\n")) {
    const match = /^\d+ path=(.*)$/u.exec(record);
    if (match) return match[1] ?? null;
  }
  return null;
}

export function listTar(bytes: Uint8Array): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let nextName: string | null = null;
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(
      readTarString(header, 124, 12).trim() || "0",
      8,
    );
    if (!Number.isSafeInteger(size) || size < 0) break;
    const type = String.fromCharCode(header[156] ?? 0);
    const dataStart = offset + 512;
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (type === "L") {
      nextName = readTarString(bytes, dataStart, size);
      continue;
    }
    if (type === "x") {
      nextName =
        readPaxPath(bytes.subarray(dataStart, dataStart + size)) ?? nextName;
      continue;
    }
    if (type === "g") continue;
    const prefix =
      readTarString(header, 257, 5) === "ustar"
        ? readTarString(header, 345, 155)
        : "";
    const baseName = readTarString(header, 0, 100);
    const name = nextName ?? (prefix ? `${prefix}/${baseName}` : baseName);
    nextName = null;
    const isDirectory = type === "5" || name.endsWith("/");
    entries.push({ name, size: isDirectory ? 0 : size, isDirectory });
  }
  return entries;
}
