import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageTransition } from "@/components/common/PageTransition";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

// Docker, nodes, logging, notifications, administration, settings and the detail pages keep one
// page across their tabs and put each tab in TabsContent: a tab switch enters that panel only.
function TabbedPage({ tab }: { tab: string }) {
  return (
    <PageTransition>
      <div>
        <h1>Docker</h1>
        <Tabs value={tab}>
          <TabsList>
            <TabsTrigger value="containers">Containers</TabsTrigger>
            <TabsTrigger value="images">Images</TabsTrigger>
          </TabsList>
          <TabsContent value="containers">
            <p>Containers list</p>
            <p>Containers footer</p>
          </TabsContent>
          <TabsContent value="images">
            <p>Images list</p>
            <p>Images footer</p>
          </TabsContent>
        </Tabs>
      </div>
    </PageTransition>
  );
}

describe("TabsContent", () => {
  let animated: Element[];

  beforeEach(() => {
    animated = [];
    Object.defineProperty(Element.prototype, "animate", {
      configurable: true,
      writable: true,
      value: function (this: Element) {
        animated.push(this);
        return {} as Animation;
      },
    });
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (Element.prototype as { animate?: unknown }).animate;
  });

  it("plays only the new panel's entrance on a tab switch", async () => {
    const { rerender } = render(<TabbedPage tab="containers" />);
    const page = document.querySelector<HTMLElement>("[data-page-transition]");
    await waitFor(() => expect(page).toHaveAttribute("data-reveal-phase", "revealed"));
    const heading = screen.getByRole("heading", { name: "Docker" });
    expect(animated).toContain(heading);
    // The first tab appears with its page, not in a second entrance of its own.
    expect(animated).not.toContain(screen.getByText("Containers list"));

    vi.setSystemTime(Date.now() + 5_000);
    animated = [];
    rerender(<TabbedPage tab="images" />);
    const panel = screen.getByText("Images list").closest<HTMLElement>("[data-page-transition]");
    await waitFor(() => expect(panel).toHaveAttribute("data-reveal-phase", "revealed"));

    expect(document.querySelector("[data-page-transition]")).toBe(page);
    expect(screen.getByRole("heading", { name: "Docker" })).toBe(heading);
    expect(animated.length).toBeGreaterThan(0);
    for (const element of animated) {
      expect(panel?.contains(element)).toBe(true);
    }
  });
});
