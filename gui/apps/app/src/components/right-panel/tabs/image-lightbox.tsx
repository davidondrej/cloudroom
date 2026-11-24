import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  ImageLightbox,
  getWrappedImageIndex,
} from "@/components/ui/image-lightbox";
import type { SecondaryPanelRenderableTab } from "@/components/right-panel/store/tab-ops";

export const IMAGE_FILE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "webp",
]);

interface LightboxImage {
  alt: string;
  src: string;
}

interface ImageTabLightboxContextValue {
  isOpen: boolean;
  open: (image: LightboxImage) => void;
  update: (image: LightboxImage) => void;
}

const ImageTabLightboxContext =
  createContext<ImageTabLightboxContextValue | null>(null);

function isImagePreviewTab(entry: SecondaryPanelRenderableTab): boolean {
  const { tab } = entry;
  if (
    tab.kind !== "workspace-file-preview" &&
    tab.kind !== "host-file-preview" &&
    tab.kind !== "thread-storage-file-preview"
  ) {
    return false;
  }
  const ext = tab.path.split(".").pop()?.toLowerCase();
  return ext !== undefined && IMAGE_FILE_EXTENSIONS.has(ext);
}

export function ImageTabLightboxProvider({
  activeTabId,
  children,
  tabs,
}: {
  activeTabId: string | null;
  children: ReactNode;
  tabs: readonly SecondaryPanelRenderableTab[];
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeImage, setActiveImage] = useState<LightboxImage | null>(null);
  const [cachedByTabId, setCachedByTabId] = useState<
    ReadonlyMap<string, LightboxImage>
  >(() => new Map());

  const imageTabs = useMemo(() => tabs.filter(isImagePreviewTab), [tabs]);

  const updateImage = useCallback(
    (next: LightboxImage) => {
      setActiveImage(next);
      if (activeTabId === null) return;
      setCachedByTabId((prev) => {
        if (prev.get(activeTabId)?.src === next.src) return prev;
        const nextMap = new Map(prev);
        nextMap.set(activeTabId, next);
        return nextMap;
      });
    },
    [activeTabId],
  );

  const navigate = useCallback(
    (direction: "previous" | "next") => {
      if (imageTabs.length <= 1) return;
      const currentIndex = imageTabs.findIndex((t) => t.tab.id === activeTabId);
      if (currentIndex === -1) return;
      const targetIndex = getWrappedImageIndex({
        currentIndex,
        direction,
        itemCount: imageTabs.length,
      });
      const target = imageTabs[targetIndex];
      if (!target) return;
      // Clear or swap immediately so the lightbox shows loading instead of the previous tab's image.
      setActiveImage(cachedByTabId.get(target.tab.id) ?? null);
      target.onSelect();
    },
    [activeTabId, cachedByTabId, imageTabs],
  );

  const contextValue = useMemo<ImageTabLightboxContextValue>(
    () => ({
      isOpen,
      open: (next) => {
        updateImage(next);
        setIsOpen(true);
      },
      update: updateImage,
    }),
    [isOpen, updateImage],
  );

  const label = activeImage?.alt ?? "Image preview";

  return (
    <ImageTabLightboxContext.Provider value={contextValue}>
      {children}
      <ImageLightbox
        imageAlt={label}
        imageSrc={isOpen ? (activeImage?.src ?? null) : null}
        isOpen={isOpen}
        title={label}
        hasMultipleImages={imageTabs.length > 1}
        onPrevious={() => navigate("previous")}
        onNext={() => navigate("next")}
        onClose={() => setIsOpen(false)}
      />
    </ImageTabLightboxContext.Provider>
  );
}

export function useImageTabLightbox(): ImageTabLightboxContextValue | null {
  return useContext(ImageTabLightboxContext);
}
