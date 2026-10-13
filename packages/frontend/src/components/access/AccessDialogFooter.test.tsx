import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AccessDialogFooter } from "./AccessDialogFooter";
import { AccessPanel } from "./AccessPanel";

const LONG_DETAIL =
  "Containers and deployments, Compose projects, routes, domains, SSL certificates, object storage, Pages";

describe("access dialog layout", () => {
  it("puts the access footer in the dialog's footer slot, outside the body", () => {
    render(
      <Dialog open>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Group</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <AccessPanel
              description="Every member gets this access."
              views={[
                {
                  key: "group",
                  line: { kind: "custom", scopes: ["admin:audit"] },
                  title: "Operator everywhere",
                  detail: LONG_DETAIL,
                  from: "operator",
                },
              ]}
            />
          </div>
          <AccessDialogFooter scopeCount={31} onReviewScopes={() => undefined}>
            <Button>Save Changes</Button>
          </AccessDialogFooter>
        </DialogContent>
      </Dialog>
    );
    const body = document.querySelector("[data-dialog-body]")!;
    const review = screen.getByRole("button", { name: "Review 31 scopes" });
    expect(body.contains(review)).toBe(false);
    expect(body.contains(screen.getByRole("button", { name: "Save Changes" }))).toBe(false);
    // The body holds only the access list: no grid sized by its widest line.
    expect(body.className).not.toMatch(/\bgrid\b/);

    // The detail ends in an ellipsis inside rows that may shrink. Detail and group share the line
    // by content (auto columns): a short group stays whole, two long ones get half each.
    const detail = screen.getByText(LONG_DETAIL);
    expect(detail.className).toMatch(/\btruncate\b/);
    expect(screen.getByText("· from operator").className).toMatch(/\btruncate\b/);
    let row = detail.parentElement!;
    expect(row.className).toContain("auto-cols-[minmax(0,auto)]");
    expect(row.getAttribute("title")).toBe(`${LONG_DETAIL} · from operator`);
    for (let level = 0; level < 3; level += 1) {
      expect(row.className).toMatch(/\bmin-w-0\b/);
      row = row.parentElement!;
    }
  });

  it("keeps a body of several parts in one column of the dialog's width", () => {
    render(
      <Dialog open>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Dialog</DialogTitle>
          </DialogHeader>
          <p>One</p>
          <p>Two</p>
        </DialogContent>
      </Dialog>
    );
    // grid-cols-1 is minmax(0, 1fr): a wide child cannot widen the column.
    expect(document.querySelector("[data-dialog-body]")!.className).toMatch(/\bgrid-cols-1\b/);
  });
});
