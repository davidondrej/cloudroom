const STYLE = `
:root{--accent:#bfff00}*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;background:#0a0a0a;color:#fafafa;font:16px/1.6 Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:440px;padding:36px;border:1px solid #303030;background:#141414}
.brand{color:inherit;text-decoration:none;font-size:24px;font-weight:700;letter-spacing:-1px}.brand span{color:var(--accent)}
h1{margin:32px 0 12px;font-size:26px;font-weight:500;letter-spacing:-.5px;line-height:1.2}
p{margin:0 0 20px;color:#b5b5b5;font-size:15px}
form{display:flex;flex-direction:column;gap:12px}
input{width:100%;height:56px;padding:0 16px;color:#fafafa;background:#1e1e1e;border:1px solid var(--accent);font:inherit;font-size:20px;letter-spacing:3px;text-transform:uppercase}
button,.button{display:flex;align-items:center;justify-content:center;min-height:48px;padding:0 20px;border:0;background:var(--accent);color:#0a0a0a;font:700 15px Arial,Helvetica,sans-serif;text-decoration:none;cursor:pointer}
.error{color:#ff8a80}.note{font-size:13px;color:#8a8a8a;margin:20px 0 0}
`;

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function page(body: string, status: number, refreshSeconds?: number): Response {
  const refresh =
    refreshSeconds === undefined
      ? ""
      : `<meta http-equiv="refresh" content="${refreshSeconds}">`;
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark">${refresh}<title>Cloudroom</title><style>${STYLE}</style></head><body><main><a class="brand" href="https://www.cloudroom.dev">cloudroom<span>.</span></a>${body}</main></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    },
  );
}

export function codePage(action: string, error?: string, status = error ? 400 : 401): Response {
  return page(
    `<h1>Open Cloudroom on your phone</h1>
     <p>Enter the code from the Cloudroom desktop app: Settings → Cloudroom Connect.</p>
     ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
     <form method="get" action="${escapeHtml(action)}"><input name="code" aria-label="Code" placeholder="ABCD-EFGH" oninput="var c=this.value.toUpperCase().replace(/[^A-Z0-9]/g,'');if(c!==this.value)this.value=c" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" required><button type="submit">Open Cloudroom</button></form>`,
    status,
  );
}

function ago(at: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

export const OFFLINE_HEADER = "x-cloudroom-offline";

export function offlinePage(lastSeenAt: number | null): Response {
  const lastSeen = lastSeenAt === null ? "" : ` It was last online ${ago(lastSeenAt)}.`;
  const response = page(
    `<h1>Your Mac is offline</h1>
     <p>Open Cloudroom on your Mac and keep it awake.${escapeHtml(lastSeen)}</p>
     <p class="note">This page retries by itself.</p>
     <button type="button" onclick="location.reload()">Retry now</button>`,
    503,
    10,
  );
  response.headers.set(OFFLINE_HEADER, "1");
  return response;
}

export function messagePage(title: string, message: string, status: number): Response {
  return page(`<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`, status);
}
