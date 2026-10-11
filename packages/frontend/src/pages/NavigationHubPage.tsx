import { useMemo } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { HubTabsProvider } from "@/components/common/HubTabs";
import {
  legacyNavigationRedirect,
  type NavigationHubId,
  navigationHub,
  visibleHubTabs,
} from "@/lib/navigation-hubs";
import { AccessLists } from "@/pages/AccessLists";
import { CAs } from "@/pages/CAs";
import { Certificates } from "@/pages/Certificates";
import { Domains } from "@/pages/Domains";
import { IngressGroups } from "@/pages/IngressGroups";
import { ProxyHosts } from "@/pages/ProxyHosts";
import { SSLCertificates } from "@/pages/SSLCertificates";
import { TemplatesPage } from "@/pages/TemplatesPage";
import { useAuthStore } from "@/stores/auth";
import { useSystemConfigStore } from "@/stores/system-config";

const NO_SCOPES: string[] = [];

function hasPkiListFilter(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has("ca") || params.has("status");
}

function tabBody(hubId: NavigationHubId, tab: string, create: boolean) {
  if (hubId === "routes") {
    switch (tab) {
      case "routes":
        return <ProxyHosts initialCreateDialogOpen={create} />;
      case "domains":
        return <Domains />;
      case "ingress-groups":
        return <IngressGroups />;
      case "access-lists":
        return <AccessLists />;
      case "templates":
        return <TemplatesPage kind="nginx" />;
    }
    return null;
  }
  switch (tab) {
    case "ssl":
      return <SSLCertificates />;
    case "authorities":
      return <CAs />;
    case "pki":
      return <Certificates />;
    case "templates":
      return <TemplatesPage kind="pki" />;
  }
  return null;
}

/**
 * The Routes or Certificates page: the former page of the open tab under one tab row. A tab the
 * user may not open goes to the first one they may; with none, back to the start page.
 */
export function NavigationHubPage({
  hubId,
  tab,
  create = false,
}: {
  hubId: NavigationHubId;
  tab: string;
  create?: boolean;
}) {
  const scopes = useAuthStore((state) => state.user?.scopes ?? NO_SCOPES);
  const pkiEnabled = useSystemConfigStore((state) => state.config.features.pkiEnabled);
  const tabs = useMemo(
    () => visibleHubTabs(navigationHub(hubId), { scopes, pkiEnabled }),
    [hubId, pkiEnabled, scopes]
  );
  const active = tabs.find((candidate) => candidate.value === tab);
  const value = useMemo(() => ({ tabs, active: tab }), [tab, tabs]);
  const location = useLocation();

  if (tabs.length === 0) return <Navigate to="/" replace />;
  // /certificates was the PKI certificate list; its filter links (?ca=, ?status=) still open that list.
  if (hubId === "certificates" && tab === "ssl" && hasPkiListFilter(location.search)) {
    return <Navigate to={`/certificates/pki${location.search}${location.hash}`} replace />;
  }
  if (!active) return <Navigate to={tabs[0].path} replace />;

  return (
    <HubTabsProvider value={value}>
      <HubTabBody key={`${hubId}:${tab}`} hubId={hubId} tab={tab} create={create} />
    </HubTabsProvider>
  );
}

function HubTabBody({
  hubId,
  tab,
  create,
}: {
  hubId: NavigationHubId;
  tab: string;
  create: boolean;
}) {
  return tabBody(hubId, tab, create);
}

/** Old page URLs (before Routes and Certificates had tabs) go to their tab, keeping query and hash. */
export function LegacyNavigationRedirect() {
  const location = useLocation();
  const scopes = useAuthStore((state) => state.user?.scopes ?? NO_SCOPES);
  const pkiEnabled = useSystemConfigStore((state) => state.config.features.pkiEnabled);
  const target = legacyNavigationRedirect(location, { scopes, pkiEnabled }) ?? "/";
  return <Navigate to={target} replace state={location.state} />;
}
