import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrollMachine } from "../../../../apps/cli/src/commands/machine-enrollment.ts";

const env = {
  ROOM_DATA_DIR: process.env.BB_DATA_DIR,
  PATH: "/nonexistent",
};
const bootstrapDir = mkdtempSync(join(tmpdir(), "bb-enrollment-bootstrap-"));
const bootstrapFile = join(bootstrapDir, "bootstrap.json");
writeFileSync(bootstrapFile, process.env.BB_ENROLLMENT, { mode: 0o600 });

try {
  await enrollMachine(
    { bootstrapFile },
    {
      env,
      fetchFn: async () =>
        Response.json(
          { hostId: "host_synthetic", hostKey: "synthetic-host-key" },
          { status: 201 },
        ),
      homeDir: process.env.BB_DATA_DIR,
      // This tests config locking; the macOS ~/.bb-machines rule has its own test.
      platform: "linux",
    },
  );
} finally {
  rmSync(bootstrapDir, { force: true, recursive: true });
}
