import { cn } from "@cloudroom/shared-ui/lib/utils";
import roomLogoUrl from "../../../../../assets/room-logo.png";

export function RoomLogo({ className = "size-4" }: { className?: string }) {
  return (
    <img
      src={roomLogoUrl}
      alt=""
      aria-hidden="true"
      className={cn(className, "object-contain")}
    />
  );
}
