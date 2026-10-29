import type { EnvironmentProvisionCommand } from "@cloudroom/host-daemon-contract";

export interface EnvironmentProvisionRequest {
  command: EnvironmentProvisionCommand;
}
