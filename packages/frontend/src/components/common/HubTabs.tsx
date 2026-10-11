import { createContext, useContext } from "react";
import { useNavigate } from "react-router-dom";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { NavigationHubTab } from "@/lib/navigation-hubs";

interface HubTabsValue {
  tabs: readonly NavigationHubTab[];
  active: string;
}

const HubTabsContext = createContext<HubTabsValue | null>(null);

export const HubTabsProvider = HubTabsContext.Provider;

/**
 * The tab row of the Routes and Certificates pages. Each page body renders it right under its
 * header; outside those pages it renders nothing.
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
