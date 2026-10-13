// The fixture backend of the app preview: the design-screen fixtures, answered with
// a network-like delay, and an idle events socket.
import { delay, HttpResponse, http, ws } from "msw";
import { webContainerHandlers } from "../design-screens/fixtures/docker/detail-sets";
import { nodesListHandlers } from "../design-screens/fixtures/nodes/sets";
import {
  adminHandlers,
  loggingHandlers,
  profileHandlers,
  scopePickerHandlers,
} from "../design-screens/fixtures/ops/handlers";
import { backgroundPrewarmHandlers } from "../design-screens/fixtures/prewarm";
import { shellHandlers } from "../design-screens/handlers";

const LATENCY_KEY = "opfield.app-preview.latency";

function latencyMs() {
  const fromQuery = new URLSearchParams(window.location.search).get("latency");
  if (fromQuery !== null) window.localStorage.setItem(LATENCY_KEY, fromQuery);
  const value = Number(fromQuery ?? window.localStorage.getItem(LATENCY_KEY) ?? 250);
  return Number.isFinite(value) && value >= 0 ? value : 250;
}

const isApi = (url: URL) => url.pathname.startsWith("/api") || url.pathname.startsWith("/auth");

export function previewHandlers() {
  const latency = latencyMs();
  const events = ws.link(/\/api\/events$/);
  return [
    // Falls through to the fixture that answers, after the delay.
    http.all("*", async ({ request }) => {
      if (isApi(new URL(request.url)) && latency > 0) await delay(latency);
    }),
    ...nodesListHandlers(),
    ...loggingHandlers(),
    ...webContainerHandlers(),
    ...adminHandlers(),
    ...profileHandlers(),
    ...scopePickerHandlers(),
    ...shellHandlers(),
    ...backgroundPrewarmHandlers(),
    http.all("*", ({ request }) => {
      if (!isApi(new URL(request.url))) return;
      return HttpResponse.json({ message: "Not in the preview fixtures" }, { status: 404 });
    }),
    events.addEventListener("connection", () => {}),
  ];
}
