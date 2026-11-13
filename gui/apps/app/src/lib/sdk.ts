import { createBrowserRoomSdk } from "@cloudroom/sdk/browser";
import { fetchWithAppSurface } from "./app-surface";

const BASE_URL =
  typeof window === "undefined" ? "http://localhost" : window.location.origin;

export const sdk = createBrowserRoomSdk({
  baseUrl: BASE_URL,
  fetch: fetchWithAppSurface,
});

export { BbHttpError } from "@cloudroom/sdk/browser";
