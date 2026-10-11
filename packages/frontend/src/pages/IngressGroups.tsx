import { Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ContentLoading } from "@/components/common/ContentLoading";
import { EmptyState } from "@/components/common/EmptyState";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { SearchFilterBar } from "@/components/common/SearchFilterBar";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
import { IngressGroupDialog } from "@/components/ingress-groups/IngressGroupDialog";
import {
  groupHealthBadge,
  MEMBER_STATE_BADGE,
  memberName,
} from "@/components/ingress-groups/ingress-group-format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useInitialLoading } from "@/hooks/use-initial-loading";
import { useRealtime } from "@/hooks/use-realtime";
import { ingressGroupRoute } from "@/lib/resource-routes";
import { hasScopeBase } from "@/lib/scope-utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { IngressGroup } from "@/types";

const NO_SCOPES: string[] = [];

export function IngressGroups() {
  const navigate = useNavigate();
  const scopes = useAuthStore((state) => state.user?.scopes ?? NO_SCOPES);
  const canCreate = hasScopeBase(scopes, "ingress:groups:manage");
  const [groups, setGroups] = useState<IngressGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const initialLoading = useInitialLoading(loading);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try {
      setGroups(await api.listIngressGroups());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load ingress groups");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useRealtime("ingress_group.changed", () => void load());
  useRealtime("node.changed", () => void load());

  // Client-side: the list is small and already loaded, and member node names are not searchable on the server.
  const filteredGroups = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return groups;
    return groups.filter((group) =>
      [
        group.name,
        group.description ?? "",
        ...group.members.flatMap((member) => [memberName(member), member.node?.hostname ?? ""]),
      ].some((value) => value.toLowerCase().includes(query))
    );
  }, [groups, search]);

  const columns: SimpleTableColumn<IngressGroup>[] = [
    {
      id: "name",
      header: "Name",
      render: (group) => (
        <div className="min-w-0">
          <p className="text-sm font-medium">{group.name}</p>
          {group.description && (
            <p className="line-clamp-1 text-xs text-muted-foreground">{group.description}</p>
          )}
        </div>
      ),
    },
    {
      id: "members",
      header: "Members",
      render: (group) => (
        <div className="flex flex-wrap gap-1">
          {group.members.map((member) => (
            <Badge
              key={member.nodeId}
              variant={
                member.state === "active" ? "secondary" : MEMBER_STATE_BADGE[member.state].variant
              }
              title={MEMBER_STATE_BADGE[member.state].label}
            >
              {memberName(member)}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      id: "usage",
      header: "Usage",
      render: (group) => (
        <span className="text-sm text-muted-foreground">
          {group.routeCount} routes · {group.domainCount} domains
        </span>
      ),
    },
    {
      id: "dns",
      header: "DNS failover",
      render: () => <span className="text-sm text-muted-foreground">None (round robin)</span>,
    },
    {
      id: "health",
      header: "Health",
      render: (group) => {
        const badge = groupHealthBadge(group);
        return <Badge variant={badge.variant}>{badge.label}</Badge>;
      },
    },
  ];

  return (
    <PageTransition>
      <div className="h-full space-y-4 overflow-y-auto p-6">
        <PageHeader
          leading={<LiteModeBackButton />}
          title="Ingress Groups"
          description="Nginx nodes that serve the same routes and domains, normally one per site"
          actions={
            canCreate ? (
              <ResponsiveHeaderActions
                actions={[
                  {
                    label: "New Group",
                    icon: <Plus className="h-4 w-4" />,
                    onClick: () => setCreating(true),
                  },
                ]}
              >
                <Button onClick={() => setCreating(true)}>
                  <Plus className="h-4 w-4" />
                  New Group
                </Button>
              </ResponsiveHeaderActions>
            ) : null
          }
        />
        <ContentLoading loading={initialLoading && groups.length === 0} />
        {initialLoading && groups.length === 0 ? null : groups.length > 0 ? (
          <>
            <SearchFilterBar
              placeholder="Search by name, description or member node..."
              search={search}
              onSearchChange={setSearch}
              hasActiveFilters={search !== ""}
              onReset={() => setSearch("")}
            />
            {filteredGroups.length > 0 ? (
              <div className="border border-border bg-card">
                <SimpleTable
                  columns={columns}
                  rows={filteredGroups}
                  getRowKey={(group) => group.id}
                  loading={loading}
                  onRowClick={(group) => navigate(ingressGroupRoute(group.id))}
                />
              </div>
            ) : (
              <EmptyState
                message="No ingress groups match your search."
                hasActiveFilters
                onReset={() => setSearch("")}
              />
            )}
          </>
        ) : (
          <EmptyState
            message="No ingress groups. A group serves routes and domains from several nginx nodes."
            {...(canCreate ? { actionLabel: "Create one", onAction: () => setCreating(true) } : {})}
          />
        )}
        <IngressGroupDialog
          open={creating}
          onOpenChange={setCreating}
          onSaved={(group) => navigate(ingressGroupRoute(group.id))}
        />
      </div>
    </PageTransition>
  );
}
