import os from "node:os";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import {
  experimental_aiServicesHostContract,
  type ExperimentalAiVoiceTranscribeOutput,
} from "@get-bb/plugin-sdk/ai-services";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { resolveClaudeNativeRoots } from "./native-roots.js";
import { claudeLoginHostContract } from "./login-contract.js";
import { ClaudeLogin } from "./host-login.js";
import { completeClaudeInference } from "./ai-inference.js";
import type { ExperimentalHostWorkerLease } from "@get-bb/plugin-sdk/host";

let lease: ExperimentalHostWorkerLease | null = null;
const login = new ClaudeLogin(() => {
  const previous = lease;
  lease = null;
  void previous?.dispose();
});

export { experimental_providerBridge } from "./bridge/bridge.js";

export default experimental_defineHostEntry({
  contract: defineRpcContract({
    ...claudeLoginHostContract,
    ...experimental_aiServicesHostContract,
  }),
  handlers: {
    async account(input, context) {
      lease ??= context.experimental_retainWorker();
      const result = await login.run(input);
      if (result.state !== "waiting") {
        const previous = lease;
        lease = null;
        void previous?.dispose();
      }
      return result;
    },
    resolveNativeRoots: (input) =>
      resolveClaudeNativeRoots({
        cwd: input.cwd,
        homeDir: os.homedir(),
        env: process.env,
      }),
    "ai.inference.complete": (input) => completeClaudeInference(input),
    "ai.voice.transcribe":
      async (): Promise<ExperimentalAiVoiceTranscribeOutput> => ({
        ok: false,
        code: "request_failed",
        message: "Claude Code does not transcribe voice.",
      }),
  },
  dispose() {
    login.stop();
    void lease?.dispose();
    lease = null;
  },
});
