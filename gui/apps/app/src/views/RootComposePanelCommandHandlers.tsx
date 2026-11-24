import { useEffect } from "react";
import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import { getRoomDesktopInfo } from "@/lib/room-desktop";

interface RootComposePanelCommandHandlersProps {
  isFocused: boolean;
  onClose: () => boolean;
  onToggle: () => void;
}

export function RootComposePanelCommandHandlers({
  isFocused,
  onClose,
  onToggle,
}: RootComposePanelCommandHandlersProps) {
  useAppCommandHandler("panel.toggle", () => {
    if (!isFocused) return false;
    onToggle();
    return true;
  });
  useAppCommandHandler("panel.close", () => {
    if (!isFocused) return false;
    return onClose();
  });
  useEffect(() => {
    if (!isFocused) return;
    const desktopInfo = getRoomDesktopInfo();
    if (desktopInfo?.onCloseWindowRequest === undefined) return;
    return desktopInfo.onCloseWindowRequest(onClose);
  }, [isFocused, onClose]);
  return null;
}
