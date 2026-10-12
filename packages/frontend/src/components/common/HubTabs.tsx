import { createContext, type ReactNode, useContext } from "react";
import { useNavigate } from "react-router-dom";
import { PageTransition } from "@/components/common/PageTransition";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { NavigationHubTab } from "@/lib/navigation-hubs";
import { cn } from "@/lib/utils";

interface HubTabsValue {
  tabs: readonly NavigationHubTab[];
  active: string;
}

const HubTabsContext = createContext<HubTabsValue | null>(null);

export const HubTabsProvider = HubTabsContext.Provider;

/**
 * The tab row of the Routes and Certificates pages. Each page body renders it right under its
 * header and puts everything below it in a `HubTabPanel`; outside those pages it renders nothing.
 */
export function HubTabs() {
  const hub = useContext(HubTabsContext);
  const navigate = useNavigate();
  if (!hub) return null;

  return (
    <Tabs
      value={hub.active}
      onValueChange={(value) => {
        const tab = hub.tabs.find((candidate) => candidate.value === value);
        if (tab) navigate(tab.path);
      }}
      className="shrink-0"
    >
      <TabsList>
        {hub.tabs.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

/**
 * Everything under the hub tab row. The hub page keeps one page gate across its tabs, so on a tab
 * switch only this panel waits for its data and plays its entrance, like a tab panel; the header
 * and tab row stay put. `className` carries the spacing the page used between its blocks.
 */
export function HubTabPanel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <PageTransition className={cn("h-auto", className)} offsetY={0}>
      {children}
    </PageTransition>
  );
}
