import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Combobox } from "@/components/common/Combobox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

describe("Combobox in a dialog", () => {
  it("Escape closes only the open dropdown, then the dialog", async () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Access</DialogTitle>
          </DialogHeader>
          <Combobox
            multiple
            ariaLabel="Covers"
            value={[]}
            options={[{ value: "routes", label: "Routes" }]}
            onValueChange={() => undefined}
          />
        </DialogContent>
      </Dialog>
    );
    const input = screen.getByRole("combobox", { name: "Covers" });
    await userEvent.click(input);
    expect(input).toHaveAttribute("aria-expanded", "true");

    await userEvent.keyboard("{Escape}");
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(onOpenChange).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("says nothing matches a typed search", async () => {
    render(
      <Combobox
        ariaLabel="Folder"
        value=""
        options={[{ value: "billing", label: "billing" }]}
        onValueChange={() => undefined}
      />
    );
    await userEvent.type(screen.getByRole("combobox", { name: "Folder" }), "zzz");
    expect(await screen.findByText("Nothing matches “zzz”.")).toBeInTheDocument();
  });
});
