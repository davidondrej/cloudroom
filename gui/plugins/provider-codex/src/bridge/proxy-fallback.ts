import { EnvHttpProxyAgent } from "undici";

let proxyAgent: EnvHttpProxyAgent | null = null;

export async function fetchWithProxyFallback(
  request: (init: { dispatcher?: EnvHttpProxyAgent }) => Promise<Response>,
): Promise<Response> {
  const hasProxy = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]
    .some((name) => process.env[name]?.trim());
  if (!hasProxy) return request({});
  try {
    const response = await request({});
    if (response.ok) return response;
  } catch {}
  proxyAgent ??= new EnvHttpProxyAgent();
  return request({ dispatcher: proxyAgent });
}
