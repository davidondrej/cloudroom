import { execFile } from "node:child_process";
// oxlint-disable-next-line no-restricted-imports
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { ApiError } from "../../errors.js";

const HEIC_MIME_TYPES = new Set([
  "image/heic",
  "image/heic-sequence",
  "image/heif",
  "image/heif-sequence",
]);

export async function heicToJpeg(file: File): Promise<File> {
  const mimeType = (file.type.split(";")[0] ?? "").trim().toLowerCase();
  if (!HEIC_MIME_TYPES.has(mimeType)) return file;
  const dir = await mkdtemp(join(tmpdir(), "cloudroom-heic-"));
  try {
    const input = join(dir, "in.heic");
    const output = join(dir, "out.jpg");
    await writeFile(input, Buffer.from(await file.arrayBuffer()));
    await promisify(execFile)(
      "sips",
      ["-s", "format", "jpeg", input, "--out", output],
      { timeout: 30_000 },
    );
    const name = `${basename(file.name, extname(file.name))}.jpg`;
    return new File([await readFile(output)], name, { type: "image/jpeg" });
  } catch {
    throw new ApiError(
      400,
      "invalid_request",
      "HEIC images are not supported. Convert the image to JPEG or PNG before attaching it.",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
