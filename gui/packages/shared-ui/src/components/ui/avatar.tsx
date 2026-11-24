import * as React from "react";
import { Slot } from "./slot";

import { cn } from "../../lib/utils";

// Same behavior as Radix Avatar 1.2: the image preloads off-DOM and mounts
// only once it has loaded; until then the fallback shows (after `delayMs`).
type ImageLoadingStatus = "idle" | "loading" | "loaded" | "error";
type SpanProps = React.ComponentPropsWithoutRef<"span"> & { asChild?: boolean };

const AvatarContext = React.createContext<{
  status: ImageLoadingStatus;
  setStatus: (status: ImageLoadingStatus) => void;
} | null>(null);

function useAvatarContext(name: string) {
  const context = React.useContext(AvatarContext);
  if (!context) throw new Error(`\`${name}\` must be used within \`Avatar\``);
  return context;
}

const Avatar = React.forwardRef<HTMLSpanElement, SpanProps>(
  ({ className, asChild, ...props }, ref) => {
    const [status, setStatus] = React.useState<ImageLoadingStatus>("idle");
    const context = React.useMemo(() => ({ status, setStatus }), [status]);
    const Component = asChild ? Slot : "span";
    return (
      <AvatarContext.Provider value={context}>
        <Component
          ref={ref}
          className={cn(
            "relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full",
            className,
          )}
          {...props}
        />
      </AvatarContext.Provider>
    );
  },
);
Avatar.displayName = "Avatar";

const AvatarImage = React.forwardRef<
  HTMLImageElement,
  React.ComponentPropsWithoutRef<"img"> & {
    asChild?: boolean;
    onLoadingStatusChange?: (status: ImageLoadingStatus) => void;
  }
>(({ className, asChild, src, onLoadingStatusChange, ...props }, ref) => {
  const { status, setStatus } = useAvatarContext("AvatarImage");
  const { crossOrigin, referrerPolicy } = props;
  React.useLayoutEffect(() => {
    if (!src) {
      setStatus("error");
      return;
    }
    const image = new window.Image();
    const updateStatus = () =>
      setStatus(
        !image.complete
          ? "loading"
          : image.naturalWidth > 0
            ? "loaded"
            : "error",
      );
    const onError = () => setStatus("error");
    image.addEventListener("load", updateStatus);
    image.addEventListener("error", onError);
    if (referrerPolicy) image.referrerPolicy = referrerPolicy;
    image.crossOrigin = crossOrigin ?? null;
    image.src = src;
    updateStatus();
    return () => {
      image.removeEventListener("load", updateStatus);
      image.removeEventListener("error", onError);
      setStatus("idle");
    };
  }, [src, crossOrigin, referrerPolicy, setStatus]);

  // Like Radix, report status changes with the callback from the last commit.
  const onStatusChange = React.useRef(onLoadingStatusChange);
  React.useEffect(() => {
    onStatusChange.current = onLoadingStatusChange;
  });
  const reportedStatus = React.useRef(status);
  React.useLayoutEffect(() => {
    if (status === reportedStatus.current) return;
    reportedStatus.current = status;
    onStatusChange.current?.(status);
  }, [status]);

  const Component = asChild ? Slot : "img";
  return status === "loaded" ? (
    <Component
      ref={ref}
      className={cn("aspect-square h-full w-full", className)}
      src={src}
      {...props}
    />
  ) : null;
});
AvatarImage.displayName = "AvatarImage";

const AvatarFallback = React.forwardRef<
  HTMLSpanElement,
  SpanProps & { delayMs?: number }
>(({ className, asChild, delayMs, ...props }, ref) => {
  const { status } = useAvatarContext("AvatarFallback");
  const [canRender, setCanRender] = React.useState(delayMs === undefined);
  React.useEffect(() => {
    if (delayMs === undefined) return;
    const timer = window.setTimeout(() => setCanRender(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs]);
  const Component = asChild ? Slot : "span";
  return canRender && status !== "loaded" ? (
    <Component
      ref={ref}
      className={cn(
        "flex h-full w-full items-center justify-center rounded-full bg-muted",
        className,
      )}
      {...props}
    />
  ) : null;
});
AvatarFallback.displayName = "AvatarFallback";

export { Avatar, AvatarImage, AvatarFallback };
