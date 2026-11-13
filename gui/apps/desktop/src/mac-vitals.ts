import { execFile } from "node:child_process";
import { statfsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { cpus, homedir } from "node:os";
import { promisify } from "node:util";
import { powerMonitor } from "electron";
import { z } from "zod";
import type { RoomDesktopVitals } from "@cloudroom/desktop-contract";

const run = promisify(execFile);
const SAMPLE_MS = 15_000;
const CPU_BUSY = 0.9;
const MEMORY_RED = 4;
const HISTORY = 20;
const HEAT: Record<string, number> = { serious: 3, critical: 4 };
const PAUSE_MIN_MS = 10 * 60_000;
const CALM: RoomDesktopVitals = { battery: null, cpuBusySince: null, memoryRedSince: null, hotSince: null, diskFreeGb: null, cpu: null, memory: null, heat: null, diskTotalGb: null, pause: null };
const quitSchema = z.object({ at: z.number(), threads: z.array(z.string()) });

/** Call when the app quits: remembers the Local threads it stops, for the next launch to report as a pause. */
export async function noteQuit(file: string, threads: string[]): Promise<void> {
  if (threads.length) await writeFile(file, JSON.stringify({ at: Date.now(), threads }));
}

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const { times } of cpus()) {
    idle += times.idle;
    total += times.idle + times.user + times.nice + times.sys + times.irq;
  }
  return { idle, total };
}

async function read(file: string, args: string[]): Promise<string> {
  return (await run(file, args, { timeout: 2_000 })).stdout;
}

async function battery(): Promise<number | null> {
  if (!powerMonitor.isOnBatteryPower()) return null;
  const percent = Number(/(\d+)%/.exec(await read("/usr/bin/pmset", ["-g", "batt"]).catch(() => ""))?.[1]);
  return Number.isFinite(percent) ? percent : null;
}

function diskGb(): { diskFreeGb: number | null; diskTotalGb: number | null } {
  try {
    const disk = statfsSync(homedir());
    return { diskFreeGb: Math.floor((disk.bavail * disk.bsize) / 1e9), diskTotalGb: Math.round((disk.blocks * disk.bsize) / 1e9) };
  } catch {
    return { diskFreeGb: null, diskTotalGb: null };
  }
}

/** `agents.working` lists the Local threads working right now. `agents.quitFile` is where `noteQuit` saved the last quit. */
export function startMacVitals(onChange: (vitals: RoomDesktopVitals) => void, agents: { working: () => Promise<string[]>; quitFile: string }): () => void {
  let vitals = CALM;
  // Kept here the whole time, so a card can show how its limit was reached. Sent only while the limit is hit.
  let cpu: number[] = [];
  let memory: number[] = [];
  let last = cpuTimes();
  let lastAt = Date.now();
  const publish = (next: RoomDesktopVitals) => {
    if (JSON.stringify(next) === JSON.stringify(vitals)) return;
    vitals = next;
    onChange(vitals);
  };
  const restart = () => {
    last = cpuTimes();
    lastAt = Date.now();
    cpu = [];
    memory = [];
    publish({ ...vitals, cpuBusySince: null, memoryRedSince: null, hotSince: null, cpu: null, memory: null, heat: null });
  };
  const sample = async () => {
    const now = Date.now();
    if (now - lastAt > 2 * SAMPLE_MS) {
      restart();
      return;
    }
    const times = cpuTimes();
    const used = times.total > last.total ? 1 - (times.idle - last.idle) / (times.total - last.total) : 0;
    last = times;
    lastAt = now;
    const pressure = Number(await read("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]).catch(() => "0"));
    cpu = [...cpu, Math.round(used * 100)].slice(-HISTORY);
    memory = [...memory, pressure].slice(-HISTORY);
    const heat = HEAT[powerMonitor.getCurrentThermalState()] ?? null;
    const since = (on: boolean, at: number | null) => (on ? (at ?? now) : null);
    publish({
      battery: await battery(),
      cpuBusySince: since(used > CPU_BUSY, vitals.cpuBusySince),
      memoryRedSince: since(pressure >= MEMORY_RED, vitals.memoryRedSince),
      hotSince: since(heat !== null, vitals.hotSince),
      ...diskGb(),
      cpu: used > CPU_BUSY ? cpu : null,
      memory: pressure >= MEMORY_RED ? memory : null,
      heat,
      pause: vitals.pause,
    });
  };
  // A sleep or a quit of 10+ minutes that stopped working Local agents (docs/scopes/laptop-hints.md#moments).
  const paused = (why: "sleep" | "quit", from: number, threads: string[]) => {
    const to = Date.now();
    if (threads.length && to - from >= PAUSE_MIN_MS) publish({ ...vitals, pause: { why, from, to, threads } });
  };
  let sleptAt: number | null = null;
  const suspend = () => {
    sleptAt = Date.now();
  };
  const resume = () => {
    restart();
    const from = sleptAt;
    sleptAt = null;
    // Nothing starts while the Mac sleeps: what works the moment it wakes was working when it fell asleep.
    if (from !== null) void agents.working().then((threads) => paused("sleep", from, threads), () => undefined);
  };
  void readFile(agents.quitFile, "utf8").then(async (text) => {
    await rm(agents.quitFile, { force: true });
    const quit = quitSchema.parse(JSON.parse(text));
    paused("quit", quit.at, quit.threads);
  }).catch(() => undefined);
  const timer = setInterval(() => void sample(), SAMPLE_MS);
  timer.unref();
  powerMonitor.on("suspend", suspend);
  powerMonitor.on("resume", resume);
  return () => {
    clearInterval(timer);
    powerMonitor.off("suspend", suspend);
    powerMonitor.off("resume", resume);
  };
}
