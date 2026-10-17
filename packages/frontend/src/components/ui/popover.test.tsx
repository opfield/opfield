import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

function SearchablePopover() {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger>Places</PopoverTrigger>
        <PopoverContent data-testid="places" onExitComplete={() => setSearch("")}>
          <input aria-label="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
          <p>{search ? `Filtered by ${search}` : "Everything"}</p>
        </PopoverContent>
      </Popover>
      <button type="button" onClick={() => setOpen(false)}>
        Elsewhere
      </button>
    </>
  );
}

/** jsdom plays no CSS animations: give the content an exit animation Radix waits for. */
function animateContent() {
  const original = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    const style = original(element, pseudo);
    if (!(element instanceof HTMLElement) || element.dataset.testid !== "places") return style;
    return new Proxy(style, {
      get(target, property) {
        if (property === "animationName")
          return element.dataset.state === "closed" ? "dropdown-out" : "dropdown-in";
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
}

afterEach(() => vi.restoreAllMocks());

describe("PopoverContent onExitComplete", () => {
  it("keeps a search while the popover closes and clears it for the next open", () => {
    animateContent();
    render(<SearchablePopover />);
    fireEvent.click(screen.getByText("Places"));
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "opf" } });

    fireEvent.pointerDown(screen.getByText("Elsewhere"));
    fireEvent.click(screen.getByText("Elsewhere"));
    // Closing: the content fades out still filtered.
    const content = screen.getByTestId("places");
    expect(content).toHaveAttribute("data-state", "closed");
    expect(screen.getByLabelText("Search")).toHaveValue("opf");
    expect(screen.getByText("Filtered by opf")).toBeInTheDocument();

    act(() => {
      const end = new Event("animationend", { bubbles: true });
      Object.assign(end, { animationName: "dropdown-out" });
      content.dispatchEvent(end);
    });
    expect(screen.queryByTestId("places")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Places"));
    expect(screen.getByLabelText("Search")).toHaveValue("");
    expect(screen.getByText("Everything")).toBeInTheDocument();
  });

  it("clears at once when the content has no close animation", () => {
    render(<SearchablePopover />);
    fireEvent.click(screen.getByText("Places"));
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "opf" } });
    fireEvent.click(screen.getByText("Places"));
    expect(screen.queryByTestId("places")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Places"));
    expect(screen.getByLabelText("Search")).toHaveValue("");
  });
});
