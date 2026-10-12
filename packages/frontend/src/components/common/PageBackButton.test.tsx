import { fireEvent, render, screen } from "@testing-library/react";
import { Link, MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetNavigationTrailRecorderForTests,
  useNavigationTrailRecorder,
} from "@/hooks/use-navigation-trail";
import { useNavigationTrailStore } from "@/stores/navigation-trail";
import { PageBackButton } from "./PageBackButton";

function Layout() {
  useNavigationTrailRecorder();
  const location = useLocation();
  return (
    <>
      <div data-testid="location">{location.pathname}</div>
      <Outlet />
    </>
  );
}

function renderConsole(initialPath: string, fallback: (path: string) => void) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route element={<Layout />}>
          <Route
            path="/docker/containers/:node/:name/:tab?"
            element={
              <>
                <PageBackButton onClick={() => fallback("/docker/containers")} />
                <Link to="/apps/shop">App badge</Link>
              </>
            }
          />
          <Route
            path="/apps/:slug/:tab?"
            element={<PageBackButton onClick={() => fallback("/apps")} />}
          />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe("PageBackButton", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    useNavigationTrailStore.getState().reset();
    resetNavigationTrailRecorderForTests();
  });

  it("returns to the page the user came from, then falls back to the logical parent", () => {
    const fallback = vi.fn();
    renderConsole("/docker/containers/n1/web/logs", fallback);

    fireEvent.click(screen.getByText("App badge"));
    expect(screen.getByTestId("location").textContent).toBe("/apps/shop");

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByTestId("location").textContent).toBe("/docker/containers/n1/web/logs");
    expect(fallback).not.toHaveBeenCalled();

    // The container page was the first page of this tab: Back now goes to its parent.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(fallback).toHaveBeenCalledWith("/docker/containers");
  });

  it("uses the fallback when the page was opened directly", () => {
    const fallback = vi.fn();
    renderConsole("/apps/shop", fallback);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(fallback).toHaveBeenCalledWith("/apps");
  });
});
