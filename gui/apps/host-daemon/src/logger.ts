import type { Logger } from "@cloudroom/logger";

export type HostDaemonLogger = Pick<
  Logger,
  "debug" | "info" | "warn" | "error"
>;
