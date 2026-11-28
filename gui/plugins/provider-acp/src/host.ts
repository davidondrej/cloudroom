import os from "node:os";
import {
  experimental_defineHostEntry,
  type ExperimentalHostWorkerLease,
} from "@get-bb/plugin-sdk/host";
import { experimental_probeAcpAgent } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { AntigravityLogin } from "./antigravity-login.js";
import { acpHostContract } from "./contract.js";
import { resolveAcpNativeRoots } from "./native-roots/index.js";

export { experimental_acpProviderBridge as experimental_providerBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";

let lease: ExperimentalHostWorkerLease | null = null;
const release = () => {
  const previous = lease;
  lease = null;
  void previous?.dispose();
};
const antigravityLogin = new AntigravityLogin(release);

export default experimental_defineHostEntry({
  contract: acpHostContract,
  handlers: {
    async antigravityLogin(input, context) {
      // A pending sign-in lives in this worker, so it must outlast the call.
      lease ??= context.experimental_retainWorker();
      const result = await antigravityLogin.run(input);
      if (result.state !== "waiting") release();
      return result;
    },
    probeAgent: async (input, context) =>
      experimental_probeAcpAgent({
        command: input.command,
        args: input.args,
        env: input.env,
        cwd: context.experimental_paths.tempDir,
      }),
    resolveNativeRoots: (input) =>
      resolveAcpNativeRoots({
        agentId: input.providerId,
        cwd: input.cwd,
        homeDir: os.homedir(),
        env: process.env,
      }),
  },
  dispose() {
    antigravityLogin.stop();
    release();
  },
});
