import { PerformanceObserver } from "node:perf_hooks";
import {
  roundDurationMs,
  startEventLoopDelaySampler,
} from "@cloudroom/process-utils";
import type { ServerLogger } from "../../types.js";
import { takeEventLoopWorkWindowSnapshot } from "./event-loop-work.js";

export interface EventLoopStallMonitorOptions {
  logger: Pick<ServerLogger, "info">;
  now?: () => number;
}

export interface EventLoopStallMonitor {
  stop: () => void;
}

const BYTES_PER_MB = 1024 * 1024;

export function startEventLoopStallMonitor(
  options: EventLoopStallMonitorOptions,
): EventLoopStallMonitor {
  let cpuStart = process.cpuUsage();
  let gcMs = 0;
  let maxGcMs = 0;
  const gcObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcMs += entry.duration;
      maxGcMs = Math.max(maxGcMs, entry.duration);
    }
  });
  gcObserver.observe({ entryTypes: ["gc"] });
  const sampler = startEventLoopDelaySampler({
    now: options.now,
    onSample: ({ stall }) => {
      const work = takeEventLoopWorkWindowSnapshot();
      const cpu = process.cpuUsage(cpuStart);
      cpuStart = process.cpuUsage();
      const gc = {
        gcMs: roundDurationMs(gcMs),
        maxGcMs: roundDurationMs(maxGcMs),
      };
      gcMs = 0;
      maxGcMs = 0;
      if (stall === null) return;
      const memory = process.memoryUsage();
      options.logger.info(
        {
          ...stall,
          ...work,
          cpuMs: roundDurationMs((cpu.user + cpu.system) / 1000),
          ...gc,
          heapUsedMb: Math.round(memory.heapUsed / BYTES_PER_MB),
          rssMb: Math.round(memory.rss / BYTES_PER_MB),
        },
        "Event loop stalled",
      );
    },
  });
  return {
    stop: () => {
      sampler.stop();
      gcObserver.disconnect();
    },
  };
}
