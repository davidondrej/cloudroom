const LEGACY_KEY = "pending";
const activeIds = new Set<number>();
let dbPromise: Promise<IDBDatabase> | null = null;

export interface SavedVoiceRecording {
  id: number;
  file: File;
}

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open("cloudroom-voice", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("recordings");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      open.result.onclose = () => {
        dbPromise = null;
      };
      resolve(open.result);
    };
  }).catch((error) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = run(db.transaction("recordings", mode).objectStore("recordings"));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const recordingRange = (id: number) => IDBKeyRange.bound([id, 0], [id, Infinity]);

export function startVoiceRecording(): number {
  const id = Date.now();
  activeIds.add(id);
  return id;
}

export const releaseVoiceRecording = (id: number) => activeIds.delete(id);

export const saveVoiceChunk = (id: number, seq: number, chunk: Blob) =>
  withStore("readwrite", (store) => store.put(chunk, [id, seq])).catch(() => {});

export const deleteVoiceRecording = (id: number) =>
  withStore("readwrite", (store) =>
    store.delete(id === 0 ? LEGACY_KEY : recordingRange(id)),
  ).catch(() => {});

export async function loadVoiceRecordings(): Promise<SavedVoiceRecording[]> {
  const chunksById = new Map<number, Blob[]>();
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction("recordings").objectStore("recordings").openCursor();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve();
        const { key, value } = cursor;
        const id = key === LEGACY_KEY ? 0 : Array.isArray(key) ? Number(key[0]) : null;
        if (id !== null && !activeIds.has(id) && value instanceof Blob) {
          chunksById.set(id, [...(chunksById.get(id) ?? []), value]);
        }
        cursor.continue();
      };
    });
  } catch {
    return [];
  }
  return [...chunksById].map(([id, chunks]) => ({
    id,
    file: createRecordingFile(chunks, chunks[0]?.type || "audio/webm"),
  }));
}

export function createRecordingFile(chunks: Blob[], mimeType: string): File {
  const extension = mimeType.includes("ogg")
    ? "ogg"
    : mimeType.includes("mp4")
      ? "mp4"
      : "webm";
  return new File(chunks, `recording.${extension}`, { type: mimeType });
}
