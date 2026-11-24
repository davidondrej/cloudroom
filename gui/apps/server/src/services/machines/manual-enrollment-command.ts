import { insecureMachineUrlAllowed } from "./server-access.js";
import type { EnrollmentBootstrap } from "./enrollments.js";

function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

export function manualEnrollmentCommand(
  bootstrap: EnrollmentBootstrap,
): string {
  const header = `X-BB-Enrollment: ${bootstrap.credential}`;
  const installerUrl = new URL("/install.sh", bootstrap.serverUrl).href;
  const optIn = insecureMachineUrlAllowed(installerUrl)
    ? "BB_ALLOW_INSECURE_SERVER_URL=1 "
    : "";
  // -q (first) ignores ~/.curlrc and no -L: a redirect could carry the enrollment header elsewhere (#2194).
  return `curl -q -fsS -H ${quote(header)} ${quote(installerUrl)} | ${optIn}sh`;
}

export function enrolledInstallerScript(
  script: string,
  bootstrap: EnrollmentBootstrap,
): string {
  return `export BB_ENROLLMENT=${quote(JSON.stringify(bootstrap))}\nset -- --bootstrap-env BB_ENROLLMENT\n${script}`;
}
