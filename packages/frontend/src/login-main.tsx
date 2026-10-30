import "@/lib/legacy-storage-keys";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { ThemeProvider } from "@/components/layout/ThemeProvider";
import { AuthCallback } from "@/pages/AuthCallback";
import { type AuthMethods, LoginPage, loadAuthMethods } from "@/pages/Login";
import "./index.css";

function readInjectedAuthMethods(): AuthMethods | null {
  const raw = document.querySelector<HTMLMetaElement>('meta[name="opfield-auth-methods"]')?.content;
  if (!raw || raw === "__OPFIELD_AUTH_METHODS__") return null;

  try {
    const methods = JSON.parse(raw) as Partial<AuthMethods>;
    if (
      typeof methods.oidc !== "boolean" ||
      typeof methods.password !== "boolean" ||
      typeof methods.emailOtp !== "boolean" ||
      typeof methods.passkeyLogin !== "boolean" ||
      (methods.demoEmailOtp !== undefined && typeof methods.demoEmailOtp !== "boolean")
    ) {
      return null;
    }
    return methods as AuthMethods;
  } catch {
    return null;
  }
}

async function startLoginApp() {
  let initialMethods = readInjectedAuthMethods();
  let initialMethodsFailed = false;

  const needsAuthMethods = window.location.pathname !== "/callback";
  if (!initialMethods && needsAuthMethods) {
    try {
      initialMethods = await loadAuthMethods();
    } catch {
      initialMethodsFailed = true;
    }
  }

  const rootElement = document.getElementById("root");
  if (!rootElement) throw new Error("Root element #root not found");

  createRoot(rootElement).render(
    <StrictMode>
      <ErrorBoundary>
        <ThemeProvider>
          <BrowserRouter>
            <Routes>
              <Route
                path="/login"
                element={
                  <LoginPage
                    initialMethods={initialMethods ?? undefined}
                    initialMethodsFailed={initialMethodsFailed}
                  />
                }
              />
              <Route
                path="/reset-password"
                element={
                  <LoginPage
                    initialMethods={initialMethods ?? undefined}
                    initialMethodsFailed={initialMethodsFailed}
                  />
                }
              />
              <Route path="/callback" element={<AuthCallback />} />
              <Route path="*" element={<Navigate to="/login" replace />} />
            </Routes>
          </BrowserRouter>
        </ThemeProvider>
      </ErrorBoundary>
    </StrictMode>
  );
}

void startLoginApp();
