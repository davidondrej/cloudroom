import { useThreads } from "@/hooks/queries/thread-queries";
import {
  ConfirmDeleteDialog,
  ConfirmDeleteDialogContent,
} from "./ConfirmDeleteDialog";

export interface ProjectDeleteDialogTarget {
  id: string;
  name: string;
}

interface ProjectDeleteDialogProps {
  target: ProjectDeleteDialogTarget | null;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: (projectId: string) => void;
}

export function ProjectDeleteDialog({
  target,
  pending,
  onOpenChange,
  onDelete,
}: ProjectDeleteDialogProps) {
  return (
    <ConfirmDeleteDialog open={target !== null} onOpenChange={onOpenChange}>
      {target ? (
        <ProjectDeleteDialogContent
          target={target}
          pending={pending}
          onDelete={onDelete}
        />
      ) : null}
    </ConfirmDeleteDialog>
  );
}

interface ProjectDeleteDialogContentProps {
  target: ProjectDeleteDialogTarget;
  pending: boolean;
  onDelete: (projectId: string) => void;
}

export function ProjectDeleteDialogContent({
  target,
  pending,
  onDelete,
}: ProjectDeleteDialogContentProps) {
  // Every computer follows a Cloud thread (#237): deleting the project here archives its Cloud threads everywhere.
  const cloud =
    useThreads({ projectId: target.id, archived: false }).data?.filter(
      (thread) => thread.executionTarget === "cloud",
    ).length ?? 0;
  const everywhere = cloud
    ? ` Archives ${cloud} Cloud thread${cloud === 1 ? "" : "s"} on every computer and stops their running work.`
    : "";
  return (
    <ConfirmDeleteDialogContent
      title="Delete project?"
      description={`Delete "${target.name}" and all of its threads, including archived ones? Your project folder on disk is not touched.${everywhere} This cannot be undone.`}
      confirmLabel="Delete project"
      pending={pending}
      onConfirm={() => onDelete(target.id)}
    />
  );
}

interface ProjectHideDialogProps {
  target: ProjectDeleteDialogTarget | null;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onHide: (projectId: string) => void;
}

export function ProjectHideDialog({
  target,
  pending,
  onOpenChange,
  onHide,
}: ProjectHideDialogProps) {
  return (
    <ConfirmDeleteDialog open={target !== null} onOpenChange={onOpenChange}>
      {target ? (
        <ConfirmDeleteDialogContent
          title="Hide project?"
          description={`Hide "${target.name}" from the sidebar? Its threads and loops keep running. To bring it back, add its folder again or use Settings → Projects.`}
          confirmLabel="Hide project"
          confirmVariant="default"
          pending={pending}
          onConfirm={() => onHide(target.id)}
        />
      ) : null}
    </ConfirmDeleteDialog>
  );
}
