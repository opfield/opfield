import "@/lib/legacy-storage-keys";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { rememberOpfieldReloadToken, stripOpfieldReloadParam } from "@/lib/opfield-update-reload";
import { registerAuthContextReset } from "@/stores/auth";
import { resetClientSessionState } from "@/stores/session-reset";
import App from "./App";
import "./index.css";

registerAuthContextReset(resetClientSessionState);

// Strip cache-bust param added by update reload
rememberOpfieldReloadToken(window.location.href);
const cleanReloadUrl = stripOpfieldReloadParam(window.location.href);
if (cleanReloadUrl != null) {
  window.history.replaceState(null, "", cleanReloadUrl);
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Root element #root not found");

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
