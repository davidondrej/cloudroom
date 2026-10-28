import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDir = join(appDir, "public");
const checkOnly = process.argv.includes("--check");
const source = await sharp(join(appDir, "../../assets/room-logo.png"))
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const raw = {
  width: source.info.width,
  height: source.info.height,
  channels: 4,
};
const colors = {
  default: "#BFFF00",
  red: "#e5484d",
  orange: "#f76b15",
  yellow: "#ffba18",
  green: "#30a46c",
  teal: "#12a594",
  blue: "#0090ff",
  purple: "#8e4ec6",
  pink: "#d6409f",
};
const mismatches = [];

async function writeOrCheck(name, content) {
  const target = join(publicDir, name);
  if (!checkOnly) return writeFile(target, content);
  const existing = await readFile(target).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (!existing?.equals(content)) mismatches.push(name);
}

function imagePixels(color, monochrome = false) {
  const pixels = Buffer.from(source.data);
  const rgb = [1, 3, 5].map((index) =>
    Number.parseInt(color.slice(index, index + 2), 16),
  );
  for (let i = 0; i < pixels.length; i += 4) {
    const [r, g, b] = pixels.subarray(i, i + 3);
    if (monochrome) {
      pixels[i + 3] = Math.round(
        pixels[i + 3] * Math.max(0, 1 - Math.max(r, g, b) / 160),
      );
      pixels.set(rgb, i);
    } else if (g > r && r > b + 60) {
      pixels.set(rgb, i);
    }
  }
  return pixels;
}

const baseManifest = JSON.parse(
  await readFile(join(publicDir, "manifest.webmanifest"), "utf8"),
);
for (const [color, hex] of Object.entries(colors)) {
  const suffix = color === "default" ? "" : `-${color}`;
  const pixels = color === "default" ? source.data : imagePixels(hex);
  for (const size of [192, 512]) {
    await writeOrCheck(
      `icon-${size}${suffix}.png`,
      await sharp(pixels, { raw }).resize(size, size).png().toBuffer(),
    );
    const inset = Math.round(size * 0.14);
    await writeOrCheck(
      `icon-${size}-maskable${suffix}.png`,
      await sharp(pixels, { raw })
        .resize(size - inset * 2, size - inset * 2)
        .extend({
          top: inset,
          bottom: inset,
          left: inset,
          right: inset,
          background: hex,
        })
        .png()
        .toBuffer(),
    );
  }
  await writeOrCheck(
    `apple-touch-icon${suffix}.png`,
    await sharp(pixels, { raw }).resize(180, 180).png().toBuffer(),
  );
  if (suffix) {
    await writeOrCheck(
      `manifest${suffix}.webmanifest`,
      Buffer.from(
        `${JSON.stringify(
          {
            ...baseManifest,
            icons: baseManifest.icons.map((icon) =>
              icon.purpose === "monochrome"
                ? icon
                : {
                    ...icon,
                    src: icon.src.replace(/\.png(?=\?|$)/u, `${suffix}.png`),
                  },
            ),
          },
          null,
          2,
        )}\n`,
      ),
    );
  }
}

for (const size of [192, 512]) {
  await writeOrCheck(
    `icon-monochrome-${size}.png`,
    await sharp(imagePixels("#ffffff", true), { raw })
      .resize(size, size)
      .png()
      .toBuffer(),
  );
}
for (const [suffix, color] of [
  ["", "#151515"],
  ["-dark", "#f8f4e2"],
  ["-dev", "#626262"],
]) {
  for (const size of [16, 32]) {
    await writeOrCheck(
      `favicon-${size}x${size}${suffix}.png`,
      await sharp(imagePixels(color, true), { raw })
        .resize(size, size)
        .png()
        .toBuffer(),
    );
  }
}
if (mismatches.length) {
  console.error(
    `Generated Cloudroom icons are out of date:\n${mismatches.join("\n")}\nRun pnpm --filter @cloudroom/app generate:pwa-icons.`,
  );
  process.exitCode = 1;
}
