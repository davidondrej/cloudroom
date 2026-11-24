import { MAX_BYTES, MIMES } from "./model.js";

type Mime = (typeof MIMES)[number];

/** Draw an image onto a canvas, shrunk so its longest side is at most `max`. */
async function shrink(source: Blob, max: number) {
  const bitmap = await createImageBitmap(source);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d")!;
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return { canvas, context, scale };
}

const toBlob = (canvas: HTMLCanvasElement, type?: string, quality?: number) =>
  new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not read this image."))), type, quality));

/**
 * Get a picked file ready to upload. Big images are shrunk to 2560 px: a JPG
 * stays a JPG, a PNG or WebP becomes WebP so it keeps its transparency (PNG in
 * browsers that cannot write WebP). GIFs stay as they are.
 */
export async function prepare(file: File): Promise<{ mime: Mime; data: string }> {
  if (!MIMES.includes(file.type as Mime)) throw new Error("Choose a JPG, PNG, WebP, or GIF.");
  let blob: Blob = file;
  if (file.type !== "image/gif") {
    const { canvas, scale } = await shrink(file, 2560).catch(() => { throw new Error("Could not read this image."); });
    if (scale < 1 || file.size > 2 * 1024 * 1024) blob = await toBlob(canvas, file.type === "image/jpeg" ? "image/jpeg" : "image/webp", 0.85);
  }
  if (blob.size > MAX_BYTES) throw new Error("That file is too big. The limit is 8 MB.");
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read this image."));
    reader.readAsDataURL(blob);
  });
  return { mime: blob.type as Mime, data: dataUrl.slice(dataUrl.indexOf(",") + 1) };
}

// 4×4 Bayer matrix: the order in which neighbouring pixels round up.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/**
 * Redraw an image as chunky pixels with four shades per colour channel.
 * Runs once per image and returns an object URL; the caller revokes it.
 */
export async function dither(url: string): Promise<string> {
  const { canvas, context } = await shrink(await (await fetch(url)).blob(), 480);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data, width } = pixels;
  for (let i = 0; i < data.length; i += 4) {
    const pixel = i / 4;
    const nudge = (BAYER[(Math.floor(pixel / width) % 4) * 4 + (pixel % width) % 4]! + 0.5) / 16 - 0.5;
    for (let channel = 0; channel < 3; channel++) {
      data[i + channel] = (Math.round((data[i + channel]! / 255) * 3 + nudge) / 3) * 255;
    }
  }
  context.putImageData(pixels, 0, 0);
  return URL.createObjectURL(await toBlob(canvas));
}
