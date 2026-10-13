import { fireEvent, render, screen } from "@testing-library/react";
import { Link, MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { LeavePageRedirect } from "@/components/common/LeavePageRedirect";
import {
  resetNavigationTrailRecorderForTests,
  useLeavePage,
  useNavigationTrailRecorder,
} from "@/hooks/use-navigation-trail";
import { useNavigationTrailStore } from "@/stores/navigation-trail";

function Layout() {
  useNavigationTrailRecorder();
  const location = useLocation();
  return (
    <>
      <div data-testid="location">{`${location.pathname}${location.search}`}</div>
      <Outlet />
    </>
  );
}

function ContainerPage() {
  const leavePage = useLeavePage();
  return (
    <>
      <button
        type="button"
        onClick={() => {
          // The delete and its own realtime event both leave: only the first one navigates.
          leavePage("/docker");
          leavePage("/docker");
        }}
      >
        Remove
      </button>
      <Link to="logs">Logs</Link>
    </>
  );
}

function renderConsole(initialEntries: Array<string | { pathname: string; state: unknown }>) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/docker" element={<div>Docker list</div>} />
          <Route
            path="/apps/:slug/:tab?"
            element={<Link to="/docker/containers/n1/web">Open web</Link>}
          />
          <Route path="/docker/containers/:node/:name/:tab?" element={<ContainerPage />} />
          <Route
            path="/docker/volumes/:node/:name"
            element={<LeavePageRedirect fallback="/docker/volumes" />}
          />
          <Route path="/docker/volumes" element={<div>Volumes list</div>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

const location = () => screen.getByTestId("location").textContent;

describe("useLeavePage", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    useNavigationTrailStore.getState().reset();
    resetNavigationTrailRecorderForTests();
  });

  it("returns to the app tab a deleted resource was opened from", () => {
    renderConsole(["/apps/shop/compute"]);
    fireEvent.click(screen.getByText("Open web"));
    fireEvent.click(screen.getByText("Logs"));
    expect(location()).toBe("/docker/containers/n1/web/logs");

    fireEvent.click(screen.getByText("Remove"));
    expect(location()).toBe("/apps/shop/compute");
    // The deleted page is no longer a step back.
    const { trail } = useNavigationTrailStore.getState();
    expect(trail.entries.map((entry) => entry.url)).toEqual(["/apps/shop/compute"]);
  });

  it("falls back to the list for a page opened directly", () => {
    renderConsole(["/docker/containers/n1/web"]);
    fireEvent.click(screen.getByText("Remove"));
    expect(location()).toBe("/docker");
  });

  it("honours a safe returnTo and ignores an unsafe one", () => {
    renderConsole([
      { pathname: "/docker/containers/n1/web", state: { returnTo: "/apps/shop/data" } },
    ]);
    fireEvent.click(screen.getByText("Remove"));
    expect(location()).toBe("/apps/shop/data");
  });

  it("does not follow an unsafe returnTo", () => {
    renderConsole([
      { pathname: "/docker/containers/n1/web", state: { returnTo: "//evil.example/x" } },
    ]);
    fireEvent.click(screen.getByText("Remove"));
    expect(location()).toBe("/docker");
  });

  it("redirects a gone page declaratively", () => {
    renderConsole(["/docker/volumes/n1/data"]);
    expect(location()).toBe("/docker/volumes");
  });
});
