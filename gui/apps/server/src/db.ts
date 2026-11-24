import { createConnection, ensurePersonalProject, migrate } from "@cloudroom/db";
import type {
  DbConnection,
  MigrationWarningLogger,
  SlowDbQueryLogger,
} from "@cloudroom/db";
import type { Logger } from "@cloudroom/logger";
import {
  exportLegacyAutomationsForPluginImport,
  hasLegacyAutomationsToExport,
} from "./legacy-automations-export.js";
import { noteBlockingEventLoopWork } from "./services/system/event-loop-work.js";

/** Enough SQL to name the query on a stall line; the full text is on its "Slow DB query" line. */
const SQL_LABEL_LENGTH = 120;

type InitDbLogger = MigrationWarningLogger &
  SlowDbQueryLogger &
  Pick<Logger, "error" | "info">;

interface InitDbOptions {
  dataDir?: string;
  logger?: InitDbLogger;
}

export function initDb(
  databasePath: string,
  options: InitDbOptions = {},
): DbConnection {
  const logger = options.logger;
  const db = createConnection(databasePath, {
    slowQueryLogger: logger && {
      info: (fields, message) => {
        noteBlockingEventLoopWork(
          `db:${fields.operation} ${fields.sql.slice(0, SQL_LABEL_LENGTH)}`,
          fields.durationMs,
        );
        logger.info(fields, message);
      },
    },
  });
  try {
    if (options.dataDir !== undefined && options.logger !== undefined) {
      exportLegacyAutomationsForPluginImport({
        dataDir: options.dataDir,
        db,
        logger: options.logger,
      });
    } else if (hasLegacyAutomationsToExport(db)) {
      throw new Error(
        "Cannot migrate legacy automations without dataDir and logger; refusing to drop kernel automation rows before exporting them for the automations plugin",
      );
    }
    migrate(db, {
      deferDestructiveLegacyCleanup: true,
      logger: options.logger,
    });
    ensurePersonalProject(db);
  } catch (error) {
    db.$client.close();
    throw error;
  }
  return db;
}
