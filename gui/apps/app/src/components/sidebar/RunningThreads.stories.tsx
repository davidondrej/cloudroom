import { makeThreadListEntry } from "@cloudroom/test-helpers/domain-fixtures";
import { RunningThreads } from "./RunningThreads";

export default { title: "sidebar/Running threads" };

export function Inventory() {
  return (
    <div
      className="max-w-[320px] rounded-lg bg-sidebar p-2 text-sidebar-foreground"
      data-inventory-ready="true"
    >
      <RunningThreads
        threads={[
          makeThreadListEntry({
            id: "thr_build",
            title: "Build the inventory",
            status: "active",
          }),
          makeThreadListEntry({
            id: "thr_worker",
            title: "Review remote changes",
            status: "active",
            parentThreadId: "thr_parent",
            visibility: "hidden",
          }),
          makeThreadListEntry({
            id: "thr_tests",
            title: "Run the integration tests",
            status: "starting",
            parentThreadId: "thr_parent",
          }),
        ]}
      />
      <details>
        <summary className="px-2 py-1 text-sm">Project (collapsed)</summary>
        <p className="px-2 text-xs">Ordinary navigation</p>
      </details>
    </div>
  );
}
