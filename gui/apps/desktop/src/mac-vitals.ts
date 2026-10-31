import { execFile } from "node:child_process";
import { statfsSync } from "node:fs";
import { cpus, homedir } from "node:os";
import { promisify } from "node:util";
import { powerMonitor } from "electron";
import type { BbDesktopVitals } from "@cloudroom/desktop-contract";

const run = promisify(execFile);
const SAMPLE_MS = 15_000;
const CPU_BUSY = 0.9;
const MEMORY_RED = 4;

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

function diskFreeGb(): number | null {
  try {
    const disk = statfsSync(homedir());
    return Math.floor((disk.bavail * disk.bsize) / 1e9);
  } catch {
    return null;
  }
}

export function startMacVitals(onChange: (vitals: BbDesktopVitals) => void): () => void {
  let vitals: BbDesktopVitals = { battery: null, cpuBusySince: null, memoryRedSince: null, hotSince: null, diskFreeGb: null };
  let last = cpuTimes();
  let lastAt = Date.now();
  const publish = (next: BbDesktopVitals) => {
    if (JSON.stringify(next) === JSON.stringify(vitals)) return;
    vitals = next;
    onChange(vitals);
  };
  const restart = () => {
    last = cpuTimes();
    lastAt = Date.now();
    publish({ ...vitals, cpuBusySince: null, memoryRedSince: null, hotSince: null });
  };
  const sample = async () => {
    const now = Date.now();
    if (now - lastAt > 2 * SAMPLE_MS) {
      restart();
      return;
    }
    const times = cpuTimes();
    const busy = times.total > last.total && 1 - (times.idle - last.idle) / (times.total - last.total) > CPU_BUSY;
    last = times;
    lastAt = now;
    const pressure = Number(await read("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]).catch(() => "0"));
    const since = (on: boolean, at: number | null) => (on ? (at ?? now) : null);
    publish({
      battery: await battery(),
      cpuBusySince: since(busy, vitals.cpuBusySince),
      memoryRedSince: since(pressure >= MEMORY_RED, vitals.memoryRedSince),
      hotSince: since(["serious", "critical"].includes(powerMonitor.getCurrentThermalState()), vitals.hotSince),
      diskFreeGb: diskFreeGb(),
    });
  };
  const timer = setInterval(() => void sample(), SAMPLE_MS);
  timer.unref();
  powerMonitor.on("resume", restart);
  return () => {
    clearInterval(timer);
    powerMonitor.off("resume", restart);
  };
}
