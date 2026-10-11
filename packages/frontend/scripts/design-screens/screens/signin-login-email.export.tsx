import { screen } from "@testing-library/react";
import { useAuthStore } from "@/stores/auth";
import { mountLoginEntry, settle, signInHandlers } from "../fixtures/signin/login-entry";
import { exportScreen } from "../harness";

it("signin-login-email", async () => {
  await exportScreen({
    id: "signin-login-email",
    title: "Sign in · Email",
    group: "Sign-in",
    route: "/login",
    handlers: signInHandlers(),
    before: () => {
      useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false });
    },
    // The sign-in page is its own entry (src/login-main.tsx) with no reveal gate.
    captureBeforeReveal: async () => {
      await mountLoginEntry();
      const { default: userEvent } = await import("@testing-library/user-event");
      const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
      await user.click(await screen.findByRole("button", { name: "Sign in with Email" }));
      await user.type(await screen.findByRole("textbox"), "lena.novak@example.com");
      await settle(600);
    },
    notes: ["The email step: Opfield picks password or one-time code for the address."],
  });
});
