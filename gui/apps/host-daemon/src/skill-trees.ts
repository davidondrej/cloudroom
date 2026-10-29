import type { HostDaemonSkillTree } from "@cloudroom/host-daemon-contract";

export type FetchSkillTree = (treeHash: string) => Promise<HostDaemonSkillTree>;
