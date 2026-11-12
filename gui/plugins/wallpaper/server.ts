import { randomBytes } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { CHANGED, DEFAULT_LOOK, MAX_BYTES, MIMES, type WallpaperState } from "./model.js";

const slot = z.number().int().min(1).max(6);
const look = z.object({ opacity: z.number().min(0).max(1), fit: z.enum(["cover", "contain"]), half: z.boolean(), dither: z.boolean() }).strict();
const state = z.object({
  active: slot.nullable(),
  slots: z.array(z.object({ slot, version: z.string(), animated: z.boolean(), look })),
});

export const rpcContract = defineRpcContract({
  get: { input: z.null(), output: state },
  upload: { input: z.object({ slot, mime: z.enum(MIMES), data: z.string() }).strict(), output: state },
  use: { input: z.object({ slot: slot.nullable() }).strict(), output: state },
  look: { input: z.object({ slot, look: look.partial() }).strict(), output: state },
  clear: { input: z.object({ slot }).strict(), output: state },
});

// The first bytes of each image type, in hex.
const SIGNATURES: Record<(typeof MIMES)[number], string> = {
  "image/jpeg": "ffd8ff",
  "image/png": "89504e47",
  "image/webp": "52494646",
  "image/gif": "47494638",
};

interface Row { slot: number; active: number; version: string; mime: string; look: string }

export default function wallpaper(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    "CREATE TABLE wallpaper (slot INTEGER PRIMARY KEY CHECK (slot BETWEEN 1 AND 6), active INTEGER NOT NULL DEFAULT 0, version TEXT NOT NULL, mime TEXT NOT NULL, look TEXT NOT NULL, image BLOB NOT NULL)",
  ]);

  function read(): WallpaperState {
    const rows = db.prepare("SELECT slot, active, version, mime, look FROM wallpaper ORDER BY slot").all() as Row[];
    return {
      active: rows.find((row) => row.active)?.slot ?? null,
      slots: rows.map((row) => ({ slot: row.slot, version: row.version, animated: row.mime === "image/gif", look: JSON.parse(row.look) })),
    };
  }
  /** Tells every open window the new state, so none has to ask for it. */
  function changed(): WallpaperState {
    const state = read();
    bb.realtime.publish(CHANGED, state);
    return state;
  }
  // `IS` so that null turns every slot off.
  const activate = (active: number | null) => db.prepare("UPDATE wallpaper SET active = (slot IS ?)").run(active);

  bb.rpc.register(rpcContract, {
    get: read,
    upload({ slot, mime, data }) {
      const image = Buffer.from(data, "base64");
      if (image.length === 0 || image.length > MAX_BYTES || !image.toString("hex", 0, 4).startsWith(SIGNATURES[mime])) {
        throw new Error("Choose a JPG, PNG, WebP, or GIF up to 8 MB.");
      }
      db.transaction(() => {
        // A new image in a used slot keeps that slot's look.
        db.prepare("INSERT INTO wallpaper (slot, version, mime, look, image) VALUES (?, ?, ?, ?, ?) ON CONFLICT(slot) DO UPDATE SET version = excluded.version, mime = excluded.mime, image = excluded.image")
          .run(slot, randomBytes(8).toString("hex"), mime, JSON.stringify(DEFAULT_LOOK), image);
        activate(slot);
      })();
      return changed();
    },
    use({ slot }) {
      activate(slot);
      return changed();
    },
    // Takes only the fields that changed, so two quick changes can't undo each other.
    look({ slot, look }) {
      const row = db.prepare("SELECT look FROM wallpaper WHERE slot = ?").get(slot) as Pick<Row, "look"> | undefined;
      if (row) db.prepare("UPDATE wallpaper SET look = ? WHERE slot = ?").run(JSON.stringify({ ...JSON.parse(row.look), ...look }), slot);
      return changed();
    },
    clear({ slot }) {
      db.prepare("DELETE FROM wallpaper WHERE slot = ?").run(slot);
      return changed();
    },
  });

  bb.http.route("GET", "/image", (context) => {
    const row = db.prepare("SELECT mime, image FROM wallpaper WHERE version = ?").get(context.req.query("v") ?? "") as { mime: string; image: Buffer } | undefined;
    if (!row) return context.notFound();
    return new Response(new Uint8Array(row.image), {
      headers: {
        "Content-Type": row.mime,
        // The version is in the address, so the browser never needs to ask again.
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'",
      },
    });
  });
}
