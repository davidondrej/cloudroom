// The one JSZip call docx-preview makes, `JSZip.loadAsync`, for the Office
// frame. It reads a .docx the way JSZip 3.10 does in a browser, so
// docx-preview finds the same parts with the same bytes and text. Inflate is
// the browser's DecompressionStream. Unlike JSZip, it refuses a broken deflate
// stream even when the size still adds up, like one with bytes after its end:
// that part then doesn't load. Real files don't have them.
// Like frameMain, it runs inside the frame from its source text, so it stays
// one self-contained function: no imports, nothing from outside its body.
//
// Ported from JSZip 3.10.2 (https://github.com/Stuk/jszip, used under MIT),
// with the UTF-8 decoder JSZip took from pako (https://github.com/nodeca/pako,
// MIT); notices in gui/NOTICE.
export function defineFrameJSZip(): void {
  const LOCAL = 0x04034b50;
  const CENTRAL = 0x02014b50;
  const END = 0x06054b50;
  const END64 = 0x06064b50;
  const LOCATOR64 = 0x07064b50;
  // JSZip hands out text and inflated bytes in blocks of this size.
  const BLOCK = 16384;
  const broken = () => new Error("Corrupted zip");

  // JSZip's reader: every read is bounds-checked, at positions counted from
  // `zero`, the bytes found before the zip (a self-extracting archive).
  function reader(data: Uint8Array) {
    const r = {
      index: 0,
      zero: 0,
      check(at: number) {
        if (data.length < r.zero + at || at < 0) throw broken();
      },
      seek(at: number) {
        r.check(at);
        r.index = at;
      },
      skip(count: number) {
        r.seek(r.index + count);
      },
      // Little-endian through 32-bit shifts, as JSZip reads it: 4 and 8 bytes
      // come back as a signed 32-bit number, so 0xffffffff is -1.
      int(size: number) {
        r.check(r.index + size);
        let value = 0;
        for (let at = r.index + size - 1; at >= r.index; at -= 1)
          value = (value << 8) + (data[r.zero + at] ?? 0);
        r.index += size;
        return value;
      },
      bytes(size: number) {
        r.check(r.index + size);
        const start = r.zero + r.index;
        r.index += size;
        return data.subarray(start, start + size);
      },
      is(at: number, signature: number) {
        const back = r.index;
        r.seek(at);
        const found = r.int(4) === signature;
        r.index = back;
        return found;
      },
      // The last place a signature appears, searching the whole file.
      last(signature: number) {
        for (let at = data.length - 4; at >= 0; at -= 1) {
          const word =
            ((data[at + 3] ?? 0) << 24) |
            ((data[at + 2] ?? 0) << 16) |
            ((data[at + 1] ?? 0) << 8) |
            (data[at] ?? 0);
          if (word === signature) return at - r.zero;
        }
        return -1;
      },
    };
    return r;
  }

  // JSZip's UTF-8 decoder (from pako). It is looser than TextDecoder: a broken
  // sequence turns into different characters, and a BOM stays. `sequence` is
  // the length of a sequence by its first byte (254 is 1, as in pako).
  const sequence = Array.from(
    { length: 256 },
    (_, byte) =>
      6 - [252, 248, 240, 224, 192, 0].findIndex((min) => byte >= min),
  );
  sequence[254] = 1;
  function utf8(bytes: Uint8Array): string {
    const units = new Uint16Array(bytes.length * 2);
    let out = 0;
    for (let at = 0; at < bytes.length;) {
      let code = bytes[at++] ?? 0;
      if (code < 0x80) {
        units[out++] = code;
        continue;
      }
      let length = sequence[code] ?? 1;
      if (length > 4) {
        units[out++] = 0xfffd;
        at += length - 1;
        continue;
      }
      code &= length === 2 ? 0x1f : length === 3 ? 0x0f : 0x07;
      while (length > 1 && at < bytes.length) {
        code = (code << 6) | ((bytes[at++] ?? 0) & 0x3f);
        length -= 1;
      }
      if (length > 1) {
        units[out++] = 0xfffd;
        continue;
      }
      if (code < 0x10000) {
        units[out++] = code;
      } else {
        code -= 0x10000;
        units[out++] = 0xd800 | ((code >> 10) & 0x3ff);
        units[out++] = 0xdc00 | (code & 0x3ff);
      }
    }
    let text = "";
    for (let at = 0; at < out; at += 8192)
      text += String.fromCharCode(
        ...units.subarray(at, Math.min(out, at + 8192)),
      );
    return text;
  }

  // An entry's text, decoded block by block as JSZip does: a character cut at
  // a block's end waits for the next block.
  function text(bytes: Uint8Array): string {
    let result = "";
    let left = new Uint8Array(0);
    for (let at = 0; at < bytes.length; at += BLOCK) {
      const block = bytes.subarray(at, at + BLOCK);
      const data = new Uint8Array(left.length + block.length);
      data.set(left);
      data.set(block, left.length);
      let start = data.length - 1;
      while (start >= 0 && ((data[start] ?? 0) & 0xc0) === 0x80) start -= 1;
      const cut =
        start > 0 && start + (sequence[data[start] ?? 0] ?? 1) > data.length
          ? start
          : data.length;
      result += utf8(data.subarray(0, cut));
      left = data.subarray(cut);
    }
    return left.length > 0 ? result + utf8(left) : result;
  }

  let crcTable: number[] | null = null;
  function crc32(bytes: Uint8Array): number {
    if (!crcTable) {
      crcTable = [];
      for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1)
          c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable.push(c);
      }
    }
    let crc = -1;
    for (const byte of bytes)
      crc = (crc >>> 8) ^ (crcTable[(crc ^ byte) & 0xff] ?? 0);
    return crc ^ -1;
  }

  // Info-ZIP's Unicode path and comment fields, used while their CRC still
  // matches the plain name or comment.
  function unicodeField(
    field: Uint8Array | undefined,
    plain: Uint8Array,
  ): string | null {
    if (!field) return null;
    const x = reader(field);
    if (x.int(1) !== 1) return null;
    if (crc32(plain) !== x.int(4)) return null;
    return utf8(x.bytes(field.length - 5));
  }

  // JSZip's path cleanup: "." and empty parts go, ".." steps back.
  function resolve(path: string): string {
    const parts = path.split("/");
    const result: string[] = [];
    parts.forEach((part, index) => {
      if (
        part === "." ||
        (part === "" && index !== 0 && index !== parts.length - 1)
      )
        return;
      if (part === "..") result.pop();
      else result.push(part);
    });
    return result.join("/");
  }

  async function inflate(
    packed: Uint8Array,
    size: number,
  ): Promise<Uint8Array> {
    const output = new Blob([packed as Uint8Array<ArrayBuffer>])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"))
      .getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await output.read();
      if (done) break;
      total += value.length;
      // Past the size it said it has, an entry can't load: stop early.
      if (total > size) {
        void output.cancel().catch(() => undefined);
        throw broken();
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    return bytes;
  }

  async function loadAsync(input: unknown) {
    const data =
      input instanceof Uint8Array
        ? input
        : input instanceof ArrayBuffer
          ? new Uint8Array(input)
          : input instanceof Blob
            ? new Uint8Array(await input.arrayBuffer())
            : null;
    if (!data) throw new Error("Can't read the data of the loaded zip file");
    const r = reader(data);

    // The end of the central directory, and its zip64 records.
    const end = r.last(END);
    if (end < 0) throw new Error("Can't find end of central directory");
    r.seek(end + 4);
    const disk = r.int(2);
    const centralDisk = r.int(2);
    const onDisk = r.int(2);
    let count = r.int(2);
    let centralSize = r.int(4);
    let centralOffset = r.int(4);
    r.bytes(r.int(2));
    let zip64Size = 0;
    const zip64 =
      disk === 0xffff ||
      centralDisk === 0xffff ||
      onDisk === 0xffff ||
      count === 0xffff ||
      centralSize === -1 ||
      centralOffset === -1;
    if (zip64) {
      const locator = r.last(LOCATOR64);
      if (locator < 0) throw broken();
      r.seek(locator + 4);
      r.int(4);
      let end64 = r.int(8);
      if (r.int(4) > 1) throw new Error("Multi-volumes zip are not supported");
      if (!r.is(end64, END64)) {
        end64 = r.last(END64);
        if (end64 < 0) throw broken();
      }
      r.seek(end64 + 4);
      zip64Size = r.int(8);
      r.skip(12);
      r.int(8);
      count = r.int(8);
      centralSize = r.int(8);
      centralOffset = r.int(8);
      // JSZip's loop over the record's extensible data never ends on its own:
      // it fails, or hangs. Fail.
      if (zip64Size - 44 > 0) throw broken();
    }
    const expected = centralOffset + centralSize + (zip64 ? 32 + zip64Size : 0);
    if (end > expected) {
      if (!r.is(end, CENTRAL)) r.zero = end - expected;
    } else if (end < expected) {
      throw broken();
    }

    // The central directory: read headers while they keep coming.
    const entries = [];
    r.seek(centralOffset);
    while (r.int(4) === CENTRAL) {
      const madeBy = r.int(2);
      r.skip(2);
      const flags = r.int(2);
      const method = r.int(2);
      r.skip(8);
      let packedSize = r.int(4);
      let size = r.int(4);
      const nameLength = r.int(2);
      const extraLength = r.int(2);
      const commentLength = r.int(2);
      r.skip(4);
      const attributes = r.int(4);
      let offset = r.int(4);
      if (flags & 1) throw new Error("Encrypted zip are not supported");
      r.skip(nameLength);
      const extras: Record<number, Uint8Array> = {};
      const extrasEnd = r.index + extraLength;
      while (r.index + 4 < extrasEnd) {
        const id = r.int(2);
        extras[id] = r.bytes(r.int(2));
      }
      r.seek(extrasEnd);
      const zip64Extra = extras[1];
      if (zip64Extra) {
        const x = reader(zip64Extra);
        if (size === -1) size = x.int(8);
        if (packedSize === -1) packedSize = x.int(8);
        if (offset === -1) offset = x.int(8);
      }
      const comment = r.bytes(commentLength);
      entries.push({
        madeBy,
        flags,
        method,
        packedSize,
        size,
        attributes,
        offset,
        extras,
        comment,
      });
    }
    if (count !== 0 && entries.length === 0) throw broken();

    // Each entry's local header: its name, and where its data starts.
    const files: Record<string, unknown> = Object.create(null);
    for (const entry of entries) {
      r.seek(entry.offset);
      if (r.int(4) !== LOCAL) throw broken();
      r.skip(22);
      const nameLength = r.int(2);
      const extraLength = r.int(2);
      const rawName = r.bytes(nameLength);
      r.skip(extraLength);
      if (entry.packedSize === -1 || entry.size === -1) throw broken();
      if (entry.method !== 0 && entry.method !== 8)
        throw new Error("Unknown compression");
      const packed = r.bytes(entry.packedSize);
      let name: string;
      if (entry.flags & 0x800) {
        name = utf8(rawName);
      } else {
        name = unicodeField(entry.extras[0x7075], rawName) ?? utf8(rawName);
        unicodeField(entry.extras[0x6375], entry.comment);
      }
      const unix =
        entry.madeBy >> 8 === 3 ? (entry.attributes >> 16) & 0xffff : 0;
      const dir = (entry.attributes & 0x10) !== 0 || name.endsWith("/");
      const folder = dir || (unix & 0x4000) !== 0;
      const safe = resolve(name);
      const key = folder && !safe.endsWith("/") ? `${safe}/` : safe;
      const empty = folder || entry.size === 0;
      const content = async (): Promise<Uint8Array> => {
        if (empty) return new Uint8Array(0);
        const bytes =
          entry.method === 0
            ? packed.slice()
            : await inflate(packed, entry.size);
        if (bytes.length !== entry.size) throw broken();
        return bytes;
      };
      files[key] = {
        name: key,
        dir: folder,
        async async(type: string) {
          const kind = String(type).toLowerCase();
          if (
            kind !== "string" &&
            kind !== "text" &&
            kind !== "uint8array" &&
            kind !== "arraybuffer" &&
            kind !== "blob"
          )
            throw new Error(`${kind} is not supported by this platform`);
          const bytes = await content();
          if (kind === "string" || kind === "text") return text(bytes);
          if (kind === "uint8array") return bytes;
          if (kind === "arraybuffer") return bytes.buffer;
          return new Blob([bytes as Uint8Array<ArrayBuffer>]);
        },
      };
      // JSZip then labels the file it just added, looked up by its name. A
      // file only its Unix mode makes a folder isn't there, so JSZip fails.
      const added = files[safe] as { dir: boolean } | undefined;
      if (!dir && (!added || added.dir)) throw broken();
    }
    return { files };
  }

  (globalThis as unknown as { JSZip: unknown }).JSZip = { loadAsync };
}
