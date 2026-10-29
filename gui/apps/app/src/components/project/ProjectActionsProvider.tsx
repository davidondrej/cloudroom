import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { useSetAtom } from "jotai";
import { useNavigate } from "react-router-dom";
import type { ProjectResponse } from "@cloudroom/server-contract";
import { useRouteState } from "@/hooks/useRouteState";
import {
  useAddLocalProjectSource,
  useSetProjectHidden,
  useUpdateProject,
} from "@/hooks/mutations/project-mutations";
import { useDialogState } from "@/hooks/useDialogState";
import {
  useLocalPathPicker,
  type LocalPathSubmitParams,
} from "@/hooks/useLocalPathPicker";
import { ProjectPathDialog } from "@/components/dialogs/ProjectPathDialog";
import {
  ProjectHideDialog,
  type ProjectDeleteDialogTarget,
} from "@/components/dialogs/ProjectDeleteDialog";
import {
  ProjectRenameDialog,
  type ProjectRenameDialogTarget,
} from "@/components/dialogs/ProjectRenameDialog";
import { collapsedProjectIdsAtom } from "@/components/sidebar/sidebarCollapsedAtoms";
import { getRootComposeRoutePath } from "@/lib/route-paths";

interface ProjectActionsContextValue {
  requestRename: (project: ProjectResponse) => void;
  requestHide: (project: ProjectResponse) => void;
  requestAddLocalPath: (project: ProjectResponse) => void;
}

const ProjectActionsContext = createContext<ProjectActionsContextValue | null>(
  null,
);

export function useProjectActions(): ProjectActionsContextValue {
  const value = useContext(ProjectActionsContext);
  if (!value) {
    throw new Error(
      "useProjectActions must be used within a <ProjectActionsProvider>",
    );
  }
  return value;
}

interface ProjectActionsProviderProps {
  children: ReactNode;
}

export function ProjectActionsProvider({
  children,
}: ProjectActionsProviderProps) {
  const navigate = useNavigate();
  const { projectId: routeProjectId } = useRouteState();
  const setCollapsedProjectIdList = useSetAtom(collapsedProjectIdsAtom);
  const updateProject = useUpdateProject();
  const setProjectHidden = useSetProjectHidden();
  const addLocalSource = useAddLocalProjectSource();
  const { mutate: updateProjectMutate } = updateProject;
  const { mutate: setProjectHiddenMutate } = setProjectHidden;
  const { mutate: addLocalSourceMutate } = addLocalSource;

  const renameDialog = useDialogState<ProjectRenameDialogTarget>();
  const hideDialog = useDialogState<ProjectDeleteDialogTarget>();

  const { onClose: closeRenameDialog, onOpen: openRenameDialog } = renameDialog;
  const { onClose: closeHideDialog, onOpen: openHideDialog } = hideDialog;

  const addLocalSourceSubmit = useCallback(
    ({ path, hostId, target, closeDialog }: LocalPathSubmitParams) => {
      if (target.kind !== "add-source") return;
      addLocalSourceMutate(
        { projectId: target.projectId, path, hostId },
        { onSuccess: closeDialog },
      );
    },
    [addLocalSourceMutate],
  );
  const addLocalSourcePicker = useLocalPathPicker({
    isPending: addLocalSource.isPending,
    submit: addLocalSourceSubmit,
  });

  const requestRename = useCallback(
    (project: ProjectResponse) => {
      openRenameDialog({ id: project.id, currentName: project.name });
    },
    [openRenameDialog],
  );

  const submitRename = useCallback(
    (projectId: string, name: string) => {
      updateProjectMutate(
        { id: projectId, name },
        { onSuccess: () => closeRenameDialog() },
      );
    },
    [closeRenameDialog, updateProjectMutate],
  );

  const requestHide = useCallback(
    (project: ProjectResponse) => {
      openHideDialog({ id: project.id, name: project.name });
    },
    [openHideDialog],
  );

  const confirmHide = useCallback(
    (projectId: string) => {
      setProjectHiddenMutate(
        { projectId, hidden: true },
        {
          onSuccess: () => {
            closeHideDialog();
            setCollapsedProjectIdList((current) =>
              current.filter((id) => id !== projectId),
            );
            if (routeProjectId === projectId) {
              navigate(getRootComposeRoutePath(), { replace: true });
            }
          },
        },
      );
    },
    [
      closeHideDialog,
      setProjectHiddenMutate,
      navigate,
      routeProjectId,
      setCollapsedProjectIdList,
    ],
  );

  const requestAddLocalPath = useCallback(
    (project: ProjectResponse) => {
      addLocalSourcePicker.openPicker({
        kind: "add-source",
        projectId: project.id,
        projectName: project.name,
      });
    },
    [addLocalSourcePicker],
  );

  const value = useMemo<ProjectActionsContextValue>(
    () => ({
      requestRename,
      requestHide,
      requestAddLocalPath,
    }),
    [requestRename, requestHide, requestAddLocalPath],
  );

  return (
    <ProjectActionsContext.Provider value={value}>
      {children}
      <ProjectRenameDialog
        target={renameDialog.target}
        pending={updateProject.isPending}
        onOpenChange={renameDialog.onOpenChange}
        onRename={submitRename}
      />
      <ProjectHideDialog
        target={hideDialog.target}
        pending={setProjectHidden.isPending}
        onOpenChange={hideDialog.onOpenChange}
        onHide={confirmHide}
      />
      <ProjectPathDialog
        target={addLocalSourcePicker.projectPathDialog.target}
        pending={addLocalSource.isPending}
        platform={addLocalSourcePicker.platform}
        hostId={addLocalSourcePicker.hostId}
        hostName={addLocalSourcePicker.hostName}
        onOpenChange={addLocalSourcePicker.projectPathDialog.onOpenChange}
        onSubmit={addLocalSourcePicker.submitProjectPath}
      />
    </ProjectActionsContext.Provider>
  );
}
