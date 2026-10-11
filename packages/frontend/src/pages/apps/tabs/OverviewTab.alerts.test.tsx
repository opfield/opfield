import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { Notice, noticeTone } from "@/components/common/Notice";
import type { AppOverviewAlert } from "@/types";
import { OverviewAlerts } from "./OverviewTab";

vi.mock("@/services/api", () => ({ api: {} }));
vi.mock("@/hooks/use-realtime", () => ({ useRealtime: () => undefined }));

describe("notice tone", () => {
  it("keeps known tones and falls back for anything else", () => {
    expect(noticeTone("destructive")).toBe("destructive");
    expect(noticeTone("warning")).toBe("warning");
    expect(noticeTone("info")).toBe("info");
    expect(noticeTone("success")).toBe("success");
    expect(noticeTone("danger")).toBe("destructive");
    expect(noticeTone("error")).toBe("destructive");
    expect(noticeTone("bogus")).toBe("warning");
    expect(noticeTone(undefined)).toBe("warning");
    expect(noticeTone("toString")).toBe("warning");
  });

  it("renders a notice with an unknown tone instead of crashing", () => {
    render(
      <Notice tone={"danger" as never} title="Legacy tone">
        Still drawn
      </Notice>
    );
    expect(screen.getByText("Legacy tone")).toHaveClass("text-destructive");
  });
});

describe("app overview alerts", () => {
  type AlertInput = Partial<AppOverviewAlert> & Pick<AppOverviewAlert, "tone" | "title">;
  const alert = (extra: AlertInput) => ({
    detail: "containers member of production",
    env: "production",
    ...extra,
  });

  it("draws a failing member as a destructive notice and a disk alert as a warning", () => {
    render(
      <MemoryRouter>
        <OverviewAlerts
          alerts={[
            alert({ tone: "destructive", title: "shop-api is failing", href: "/docker/c1" }),
            alert({ tone: "warning", title: "shop-db disk is 90% full", detail: "Free space" }),
          ]}
        />
      </MemoryRouter>
    );
    expect(screen.getByText("production · shop-api is failing")).toHaveClass("text-destructive");
    expect(screen.getByText("production · shop-db disk is 90% full")).toHaveClass(
      "text-warning-text"
    );
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("href", "/docker/c1");
  });

  it("still renders an alert whose tone the console does not know", () => {
    const unknownTone = "danger" as never;
    render(
      <MemoryRouter>
        <OverviewAlerts alerts={[alert({ tone: unknownTone, title: "old-api is failing" })]} />
      </MemoryRouter>
    );
    expect(screen.getByText("production · old-api is failing")).toHaveClass("text-destructive");
  });

  it("says there are no open alerts when the list is empty", () => {
    render(
      <MemoryRouter>
        <OverviewAlerts alerts={[]} />
      </MemoryRouter>
    );
    expect(screen.getByText("No open alerts")).toBeInTheDocument();
  });
});
