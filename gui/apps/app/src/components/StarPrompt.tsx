import { useEffect, useRef } from "react";
import { atom, useAtom } from "jotai";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { PromptStackCard } from "@/components/promptbox/banner/PromptStackCard";
import { BbLogo } from "@/components/ui/bb-logo";
import { useIsNativeBrowserViewShown } from "@/hooks/useBrowserDimmingModal";
import { fetchWithAppSurface, getAppSurface } from "@/lib/app-surface";
import { claimStarCard, closeStarCard, usePopup } from "@/lib/popups";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

const PATH = "/api/v1/cloudroom/star-prompt";
type Prompt = { eligible: boolean; card: boolean; done: boolean; login: string | null; url: string; days: number; stars: number | null };
const cardAtom = atom<{ url: string; stars: number | null } | null>(null);
const cardClaim = { pending: false, handledAt: 0 };

function useStarPrompt(surface: "popup" | "card") {
  return useQuery<Prompt>({
    queryKey: ["cloudroom-star-prompt", surface], enabled: getAppSurface() === "desktop", retry: false,
    queryFn: async ({ signal }) => {
      const response = await fetchWithAppSurface(PATH, { signal });
      if (!response.ok) throw new Error("The star prompt is unavailable.");
      return await response.json() as Prompt;
    },
  });
}

async function starOnGitHub(url: string): Promise<"starred" | "opened"> {
  const response = await fetchWithAppSurface(PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => null);
  const starred = (await response?.json().catch(() => null) as { starred?: boolean } | null)?.starred === true;
  openUrlInExternalBrowser(url);
  return starred ? "starred" : "opened";
}

export function StarPrompt() {
  const nativeBrowserShown = useIsNativeBrowserViewShown();
  const card = useRef<HTMLDivElement>(null);
  const desktop = getAppSurface() === "desktop";
  const { data, isError } = useStarPrompt("popup");
  const popup = usePopup("star", !desktop || isError ? false : data ? data.eligible : null);
  const answer = useMutation({
    mutationFn: async (action: "star" | "dismiss") => action === "star" && data ? await starOnGitHub(data.url) : undefined,
    onSettled: (detail) => popup.close(detail),
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
            <StarIcon className="size-[15px]" />Star on GitHub
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

export function StarCard({ active, attached }: { active: boolean; attached: boolean }) {
  const desktop = getAppSurface() === "desktop";
  const { data, dataUpdatedAt, refetch } = useStarPrompt("card");
  const [card, setCard] = useAtom(cardAtom);
  const close = (detail?: "starred" | "opened") => {
    cardClaim.handledAt = Date.now();
    setCard(null);
    closeStarCard(detail);
  };
  const star = useMutation({
    mutationFn: (url: string) => starOnGitHub(url),
    onSettled: (detail) => close(detail ?? "opened"),
  });
  useEffect(() => { if (active && desktop) void refetch(); }, [active, desktop, refetch]);
  useEffect(() => { if (card && data?.done) setCard(null); }, [card, data?.done, setCard]);
  useEffect(() => {
    if (!data?.card || card || cardClaim.pending || dataUpdatedAt <= cardClaim.handledAt) return;
    const { url, stars } = data;
    cardClaim.pending = true;
    cardClaim.handledAt = Date.now();
    void claimStarCard().then((claimed) => { if (claimed) setCard({ url, stars }); }).finally(() => { cardClaim.pending = false; });
  }, [card, data, dataUpdatedAt, setCard]);
  if (!card) return null;
  const count = card.stars?.toLocaleString("en-US");
  return (
    <PromptStackCard ariaLabel="Star Cloudroom on GitHub" className={cn("mx-3 overflow-hidden rounded-xl border-muted-foreground/15 sm:mx-4", attached && "relative z-10 -mb-5 rounded-b-none border-b-0 pb-3")}>
      <div data-testid="star-card" className="flex min-h-10 items-center gap-2.5 px-3 py-2 text-xs">
        <Icon name="GithubLogo" className="size-4 shrink-0 text-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-foreground">
          {count ? <><span className="font-semibold">{count} developers</span> starred Cloudroom on GitHub. </> : "Cloudroom is open source on GitHub. "}
          <span className="text-muted-foreground">{count ? "Join them?" : "A star helps more people find it."}</span>
        </span>
        <span className="flex shrink-0 overflow-hidden rounded-md border border-border text-[12px] font-medium">
          <button type="button" disabled={star.isPending} onClick={() => star.mutate(card.url)}
            className="flex cursor-pointer items-center gap-1.5 bg-surface-raised-solid px-2.5 py-1 text-foreground transition-colors hover:bg-state-hover disabled:opacity-50">
            <StarIcon className="size-3.5 text-muted-foreground" />Star
          </button>
          {count && <span className="border-l border-border bg-background px-2.5 py-1 text-foreground tabular-nums">{count}</span>}
        </span>
        <button type="button" aria-label="Dismiss" disabled={star.isPending} onClick={() => close()}
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground">
          <Icon name="X" className="size-3.5" aria-hidden="true" />
        </button>
      </div>
    </PromptStackCard>
  );
}

const StarIcon = ({ className }: { className: string }) => <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden="true"><path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z" /></svg>;
