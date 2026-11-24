import { useQuery } from "@tanstack/react-query";
import { Icon } from "@cloudroom/shared-ui/icon";
import { useCorner } from "@cloudroom/shared-ui/lib/corner";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

// The call ticket at the top right (docs/scopes/calls.md#the-ticket-in-the-app): an account that pays and has no call
// booked sees it until it books one, and again 30 days after a call. The website decides who is owed it and gives the
// booking link. The corner module decides when it may show (docs/scopes/corner-cards.md): closing or clicking it
// hides it for 3 days. Same size and place as the Wrapped card.
type Ticket = { link: string; plan: string; again: boolean };
/** The plan on the stub. A Free account with a ticket bought credits. */
const PLANS: Record<string, string> = { pro: "Pro", super: "Super", ultra: "Ultra", business: "Business" };

export function CallTicket() {
  const plan = useCloudroomAccount().data?.plan;
  // The app's own server answers from memory and asks the website at most once an hour.
  const { data: ticket } = useQuery<Ticket | null>({
    queryKey: ["cloudroom-call-ticket", plan ?? null], enabled: Boolean(plan), retry: false, staleTime: 10 * 60_000,
    queryFn: async ({ signal }) => {
      const response = await fetchWithAppSurface("/api/v1/cloudroom/call-ticket", { signal });
      return response.ok ? (await response.json() as { ticket: Ticket | null }).ticket : null;
    },
  });
  const corner = useCorner("call", ticket ? (ticket.again ? "again" : "first") : null);
  if (!corner || !ticket) return null;
  const name = PLANS[ticket.plan] ?? "Credits";
  return (
    <div data-testid="call-ticket" style={{ ...corner.style, filter: "drop-shadow(0 18px 26px rgba(0,0,0,.6)) drop-shadow(0 2px 5px rgba(0,0,0,.5))" }} className={cn(corner.className, "h-[176px] w-[340px]")}>
      {/* A paper ticket: the two notches sit on the tear line between the ticket and its stub. */}
      <div className="relative size-full rounded-[10px] bg-[#F4EFDF] text-[#111]"
        style={{ WebkitMaskImage: "radial-gradient(circle at 247px 0, transparent 9px, #000 9.5px), radial-gradient(circle at 247px 100%, transparent 9px, #000 9.5px)", WebkitMaskComposite: "source-in", maskComposite: "intersect" }}>
        <button type="button" onClick={() => { corner.answer("opened"); openUrlInExternalBrowser(ticket.link); }}
          className="absolute inset-0 grid cursor-pointer grid-cols-[247px_1fr] rounded-[10px] text-left outline-none focus-visible:ring-2 focus-visible:ring-current focus-visible:ring-inset">
          <span className="relative block px-4 pt-[20px]">
            <span className="block font-mono text-[10px] tracking-[0.16em] text-[#555] uppercase">Paying customers only</span>
            <span className="mt-[7px] block text-[29px] leading-none font-extrabold tracking-[-0.045em] whitespace-nowrap">Claim your call.</span>
            <span className="mt-[9px] block text-[12.5px] leading-[1.35] text-[#444]">30 minutes with David or one of the devs who built Cloudroom.</span>
            <span className="absolute bottom-4 left-4 flex h-8 items-center gap-[7px] rounded-[7px] bg-[#111] px-3.5 text-[13px] font-semibold text-[#F4EFDF]">
              Book my call<Icon name="ArrowRight" className="size-3.5" aria-hidden="true" />
            </span>
          </span>
          <span className="flex flex-col justify-between border-l-2 border-dashed border-[#b9b29c] pt-[52px] pr-2 pb-[18px] pl-3 font-mono text-[9px] leading-[1.5] tracking-[0.06em] whitespace-nowrap text-[#555] uppercase">
            <span className="block">
              <span className="block">Free with</span>
              <b className={cn("mt-0.5 block leading-none font-normal tracking-normal text-[#111] normal-case italic", name.length <= 3 ? "text-[30px]" : name.length <= 5 ? "text-[25px]" : "text-[17px]")} style={{ fontFamily: "Georgia, serif" }}>{name}</b>
            </span>
            <span className="block">30 min<br />Google Meet</span>
          </span>
        </button>
        <button type="button" aria-label="Dismiss" onClick={() => corner.answer("closed")}
          className="absolute top-[14px] right-3 flex size-6 cursor-pointer items-center justify-center rounded hover:bg-current/10">
          <Icon name="X" className="size-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
