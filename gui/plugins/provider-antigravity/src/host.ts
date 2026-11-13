import {
  experimental_defineHostEntry,
  type ExperimentalHostWorkerLease,
} from "@get-bb/plugin-sdk/host";
import { AntigravityLogin } from "./host-login.js";
import { antigravityLoginHostContract } from "./login-contract.js";

// Antigravity's CLI speaks ACP, so its threads run on the SDK's ACP bridge.
export { experimental_acpProviderBridge as experimental_providerBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";

let lease: ExperimentalHostWorkerLease | null = null;
const release = () => {
  const previous = lease;
  lease = null;
  void previous?.dispose();
};
const login = new AntigravityLogin(release);

export default experimental_defineHostEntry({
  contract: antigravityLoginHostContract,
  handlers: {
    async account(input, context) {
      // A pending sign-in lives in this worker, so it must outlast the call.
      lease ??= context.experimental_retainWorker();
      const result = await login.run(input);
      if (result.state !== "waiting") release();
      return result;
    },
  },
  dispose() {
    login.stop();
    release();
  },
});
