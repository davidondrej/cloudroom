// `node --import tsx scripts/set-env.mjs NAME=value... command [args...]` sets
// the variables, then runs the command on every OS. It replaced cross-env.
import { spawnPortableProcess } from "../packages/process-utils/src/index.ts";

const argv = process.argv.slice(2);
const env = { ...process.env };
let index = 0;
for (; index < argv.length; index++) {
  const assignment = /^(\w+)=(.*)$/su.exec(argv[index]);
  if (!assignment) break;
  env[assignment[1]] = assignment[2];
}
const [command, ...args] = argv.slice(index);
if (!command) {
  process.stderr.write("Usage: set-env.mjs NAME=value... command [args...]\n");
  process.exit(1);
}

const child = spawnPortableProcess({ command, args, env, stdio: "inherit" });
// The signals cross-env forwarded.
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
  process.stderr.write(`set-env: ${command}: ${error.message}\n`);
  process.exit(1);
});
// Like cross-env, Ctrl+C exits 0 and any other signal exits 1.
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal === "SIGINT" ? 0 : 1));
});
