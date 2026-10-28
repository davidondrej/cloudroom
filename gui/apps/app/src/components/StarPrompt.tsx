import { useEffect, useRef } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BbLogo } from "@/components/ui/bb-logo";
import { useIsNativeBrowserViewShown } from "@/hooks/useBrowserDimmingModal";
import { fetchWithAppSurface, getAppSurface } from "@/lib/app-surface";
import { usePopup } from "@/lib/popups";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

const PATH = "/api/v1/cloudroom/star-prompt";
type Prompt = { eligible: boolean; login: string | null; url: string; days: number };

export function StarPrompt() {
  const nativeBrowserShown = useIsNativeBrowserViewShown();
  const card = useRef<HTMLDivElement>(null);
  const desktop = getAppSurface() === "desktop";
  const { data, isError } = useQuery<Prompt>({
    queryKey: ["cloudroom-star-prompt"], enabled: desktop, retry: false,
    queryFn: async ({ signal }) => {
      const response = await fetchWithAppSurface(PATH, { signal });
      if (!response.ok) throw new Error("The star prompt is unavailable.");
      return await response.json() as Prompt;
    },
  });
  const popup = usePopup("star", !desktop || isError ? false : data ? data.eligible : null);
  const answer = useMutation({
    mutationFn: async (action: "star" | "dismiss") => {
      if (action === "dismiss") return null;
      const response = await fetchWithAppSurface(PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      return (await response.json().catch(() => null) as { starred?: boolean } | null)?.starred === true;
    },
    onSettled: (starred, _error, action) => {
      if (action === "dismiss") return popup.close();
      if (data) openUrlInExternalBrowser(data.url);
      popup.close(starred ? "starred" : "opened");
    },
  });
  const open = popup.open && data !== undefined && !nativeBrowserShown;
  useEffect(() => { if (open) card.current?.focus(); }, [open]);
  if (!open) return null;
  const dismiss = () => { if (!answer.isPending) answer.mutate("dismiss"); };
  return (
    <div onClick={dismiss} className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[5px] duration-200 animate-in fade-in-0">
      <div ref={card} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Star Cloudroom on GitHub" data-testid="star-prompt"
        onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") dismiss(); }}
        className="w-[430px] max-w-full border border-[#e4dcc6] bg-[#f7f3e8] px-[34px] pt-[34px] pb-7 text-[#29251e] shadow-[0_30px_80px_rgba(0,0,0,.55),0_4px_14px_rgba(0,0,0,.3)] outline-none duration-200 animate-in fade-in-0 zoom-in-95">
        <BbLogo className="size-[58px] -rotate-[4deg]" />
        <p className="mt-[22px] font-serif text-[15px] text-[#6f6655] italic">{data.days > 1 ? `Day ${data.days} with Cloudroom` : "Your first day with Cloudroom"}</p>
        <h2 className="mt-1.5 font-serif text-[40px] leading-[1.05] tracking-[-0.02em]">
          Enjoying <em className="bg-[linear-gradient(transparent_58%,#bfff00_58%,#bfff00_92%,transparent_92%)]">Cloudroom</em>?
        </h2>
        <p className="mt-3 text-[14.5px] leading-normal text-[#5f584a]">It's open source. A star on GitHub helps more people find it.</p>
        <div className="mt-[26px] flex items-center gap-[22px]">
          <button type="button" disabled={answer.isPending} onClick={() => answer.mutate("star")}
            className="inline-flex h-[46px] items-center gap-2.5 bg-[#29251e] px-[22px] text-[15px] font-semibold text-[#f7f3e8] transition-opacity hover:opacity-90 disabled:opacity-40">
            <StarIcon />Star on GitHub
          </button>
          <button type="button" disabled={answer.isPending} onClick={dismiss} className="text-[13.5px] text-[#7d735f] underline underline-offset-4 hover:text-[#29251e]">
            Not now
          </button>
        </div>
        {data.login && <p className="mt-4 text-xs text-[#8d8676]">One click. Stars as @{data.login}.</p>}
      </div>
    </div>
  );
}

const StarIcon = () => <svg viewBox="0 0 16 16" className="size-[15px]" fill="currentColor" aria-hidden="true"><path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z" /></svg>;
