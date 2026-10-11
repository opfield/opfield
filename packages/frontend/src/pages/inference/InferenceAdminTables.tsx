import { Gauge, SlidersHorizontal } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Combobox, type ComboboxOption } from "@/components/common/Combobox";
import { confirm } from "@/components/common/ConfirmDialog";
import { PanelShell } from "@/components/common/PanelShell";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SearchFilterBar } from "@/components/common/SearchFilterBar";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { formatDateTime } from "@/lib/utils";
import { api } from "@/services/api";
import type {
  InferenceLimitInput,
  InferenceLimitPolicy,
  InferenceUserUsage,
} from "@/types/inference";

const EMPTY_LIMITS: InferenceLimitInput = {
  enabled: true,
  credits5hEnabled: false,
  credits5h: 0,
  credits7dEnabled: false,
  credits7d: 0,
  credits30dEnabled: false,
  credits30d: 0,
  apiMonthlyMicrodollars: 0,
  billingTimezone: "UTC",
};

const DEFAULT_API_MONTHLY_DOLLARS = 10;

type CreditLimitDraft = {
  credits5h: string;
  credits7d: string;
  credits30d: string;
};

const BILLING_TIMEZONE_OPTIONS: ComboboxOption[] = [
  "UTC",
  ...Intl.supportedValuesOf("timeZone").filter((timezone) => timezone !== "UTC"),
].map((timezone) => ({
  value: timezone,
  label: timezone,
  keywords: timezone.replaceAll("_", " "),
}));

function getUserInitials(name: string | null, email: string): string {
  if (name) {
    return name
      .split(" ")
      .map((part) => part[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase();
  }
  return email[0]?.toUpperCase() ?? "?";
}

export function InferenceUsersTable({
  canManage,
  canViewUsage = true,
  refreshToken = 0,
}: {
  canManage: boolean;
  canViewUsage?: boolean;
  refreshToken?: number;
}) {
  const usersCacheKey = canViewUsage
    ? "req:/api/inference/usage/users"
    : "req:/api/inference/limits/users";
  const cachedUsers = api.getCached<InferenceUserUsage[]>(usersCacheKey, Number.POSITIVE_INFINITY);
  const cachedPolicies = canManage
    ? api.getCached<InferenceLimitPolicy[]>("req:/api/inference/limits", Number.POSITIVE_INFINITY)
    : [];
  const hasCachedData = cachedUsers !== undefined && cachedPolicies !== undefined;
  const [users, setUsers] = useState<InferenceUserUsage[]>(cachedUsers ?? []);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(!hasCachedData);
  const [policies, setPolicies] = useState<InferenceLimitPolicy[]>(cachedPolicies ?? []);
  const [editing, setEditing] = useState<InferenceUserUsage | null>(null);
  const [editingDefault, setEditingDefault] = useState(false);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_LIMITS);
  const [creditLimitDraft, setCreditLimitDraft] = useState<CreditLimitDraft>(() =>
    creditLimitDraftFrom(EMPTY_LIMITS)
  );
  const [apiDollars, setApiDollars] = useState("0");
  const [apiUsageEnabled, setApiUsageEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [removingOverride, setRemovingOverride] = useState(false);
  const initializedRef = useRef(hasCachedData);
  const loadGeneration = useRef(0);
  useContentLoading(loading);

  const parsedCredits5h = parseNonNegativeNumber(creditLimitDraft.credits5h);
  const parsedCredits7d = parseNonNegativeNumber(creditLimitDraft.credits7d);
  const parsedCredits30d = parseNonNegativeNumber(creditLimitDraft.credits30d);
  const parsedApiDollars = parseNonNegativeNumber(apiDollars);
  const formValid =
    Boolean(form.billingTimezone.trim()) &&
    (!form.credits5hEnabled || parsedCredits5h !== null) &&
    (!form.credits7dEnabled || parsedCredits7d !== null) &&
    (!form.credits30dEnabled || parsedCredits30d !== null) &&
    (!apiUsageEnabled || (parsedApiDollars !== null && parsedApiDollars > 0));

  const load = useCallback(
    async ({
      showLoading = !initializedRef.current,
      savedPolicies,
    }: {
      showLoading?: boolean;
      savedPolicies?: InferenceLimitPolicy[];
    } = {}) => {
      const generation = ++loadGeneration.current;
      if (showLoading) setLoading(true);
      try {
        const [nextUsers, nextPolicies] = await Promise.all([
          canViewUsage ? api.listInferenceUsersUsage() : api.listInferenceLimitUsers(),
          savedPolicies !== undefined
            ? Promise.resolve(savedPolicies)
            : canManage
              ? api.listInferenceLimits()
              : Promise.resolve([]),
        ]);
        if (generation !== loadGeneration.current) return;
        setUsers(nextUsers);
        setPolicies(nextPolicies);
        initializedRef.current = true;
      } catch (error) {
        if (generation !== loadGeneration.current) return;
        toast.error(error instanceof Error ? error.message : "Failed to load inference users");
      } finally {
        if (generation === loadGeneration.current) setLoading(false);
      }
    },
    [canManage, canViewUsage]
  );

  useEffect(() => {
    void refreshToken;
    void load();
  }, [load, refreshToken]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query
      ? users.filter((user) => `${user.name ?? ""} ${user.email}`.toLowerCase().includes(query))
      : users;
  }, [search, users]);

  const edit = (user: InferenceUserUsage) => {
    const override = policies.find(
      (policy) => policy.policyType === "user" && policy.userId === user.id
    );
    const policy = override ?? policies.find((item) => item.policyType === "default");
    const next = policy ? policyInput(policy) : (user.limits ?? EMPTY_LIMITS);
    setEditing(user);
    setEditingDefault(false);
    setForm(next);
    setCreditLimitDraft(creditLimitDraftFrom(next));
    setApiDollars(String(next.apiMonthlyMicrodollars / 1_000_000));
    setApiUsageEnabled(next.apiMonthlyMicrodollars > 0);
    setLimitsOpen(true);
  };

  const editDefault = () => {
    const policy = policies.find((item) => item.policyType === "default");
    const next = policy ? policyInput(policy) : EMPTY_LIMITS;
    setEditingDefault(true);
    setEditing(null);
    setForm(next);
    setCreditLimitDraft(creditLimitDraftFrom(next));
    setApiDollars(String(next.apiMonthlyMicrodollars / 1_000_000));
    setApiUsageEnabled(next.apiMonthlyMicrodollars > 0);
    setLimitsOpen(true);
  };

  const save = async () => {
    if ((!editing && !editingDefault) || !formValid) return;
    setSaving(true);
    try {
      const payload = {
        ...form,
        credits5h: parsedCredits5h ?? 0,
        credits7d: parsedCredits7d ?? 0,
        credits30d: parsedCredits30d ?? 0,
        apiMonthlyMicrodollars:
          apiUsageEnabled && parsedApiDollars !== null
            ? Math.round(parsedApiDollars * 1_000_000)
            : 0,
      };
      const savedPolicies = editingDefault
        ? await api.setInferenceDefaultLimits(payload)
        : await api.setInferenceUserLimits(editing!.id, payload);
      setPolicies(savedPolicies);
      setLimitsOpen(false);
      toast.success(editingDefault ? "Default limits updated" : "User limits updated");
      // The PUT is the save acknowledgement. Usage aggregation is a separate
      // refresh, and must neither delay success nor replay older policy data.
      void load({ showLoading: false, savedPolicies });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update limits");
    } finally {
      setSaving(false);
    }
  };

  const resetLimits = async () => {
    if (!editing) return;
    if (
      !(await confirm({
        title: "Reset Usage Limits?",
        description: `Reset all active inference usage windows for ${editing.email}? Current usage will become zero. New subscription windows will start with the user's next inference request.`,
        confirmLabel: "Reset limits",
        variant: "default",
      }))
    ) {
      return;
    }
    setResetting(true);
    try {
      const result = await api.resetInferenceUserLimits(editing.id);
      setEditing((current) => (current ? { ...current, usage: result.usage } : current));
      setUsers((current) =>
        current.map((user) => (user.id === editing.id ? { ...user, usage: result.usage } : user))
      );
      toast.success("Usage limits reset");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to reset limit usage");
    } finally {
      setResetting(false);
    }
  };

  const revertToDefaultLimits = async () => {
    if (!editing) return;
    setRemovingOverride(true);
    try {
      await api.deleteInferenceUserLimits(editing.id);
      setLimitsOpen(false);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to remove the limit override");
    } finally {
      setRemovingOverride(false);
    }
  };

  const columns: DataTableColumn<InferenceUserUsage>[] = [
    {
      key: "user",
      header: "User",
      width: "minmax(13rem,1.4fr)",
      render: (user) => (
        <div className="flex min-w-0 items-center gap-3">
          <Avatar className="h-9 w-9 shrink-0">
            <AvatarImage src={user.avatarUrl ?? undefined} />
            <AvatarFallback className="text-xs">
              {getUserInitials(user.name, user.email)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate font-medium">{user.name || user.email}</p>
            <p className="truncate text-xs text-muted-foreground">{user.email}</p>
          </div>
        </div>
      ),
    },
    {
      key: "access",
      header: "Access",
      width: "7rem",
      render: (user) => (
        <Badge variant={user.limits?.enabled ? "success" : "secondary"} size="inline">
          {user.limits?.enabled ? "enabled" : "disabled"}
        </Badge>
      ),
    },
    {
      key: "api",
      header: "API",
      width: "10rem",
      render: (user) =>
        canViewUsage
          ? budgetCell(
              user.usage?.apiMonthlyMicrodollars,
              user.limits?.apiMonthlyMicrodollars,
              true
            )
          : policyCell(user.limits?.apiMonthlyMicrodollars, true),
    },
    {
      key: "5h",
      header: "5h",
      width: "9rem",
      render: (user) =>
        canViewUsage
          ? budgetCell(
              user.usage?.credits5h,
              user.limits?.credits5h,
              false,
              user.limits?.credits5hEnabled
            )
          : policyCell(user.limits?.credits5h, false, user.limits?.credits5hEnabled),
    },
    {
      key: "7d",
      header: "7d",
      width: "9rem",
      render: (user) =>
        canViewUsage
          ? budgetCell(
              user.usage?.credits7d,
              user.limits?.credits7d,
              false,
              user.limits?.credits7dEnabled
            )
          : policyCell(user.limits?.credits7d, false, user.limits?.credits7dEnabled),
    },
    {
      key: "30d",
      header: "30d",
      width: "9rem",
      render: (user) =>
        canViewUsage
          ? budgetCell(
              user.usage?.credits30d,
              user.limits?.credits30d,
              false,
              user.limits?.credits30dEnabled
            )
          : policyCell(user.limits?.credits30d, false, user.limits?.credits30dEnabled),
    },
  ];
  const defaultPolicy = policies.find((policy) => policy.policyType === "default");
  const globallyEnabled = {
    credits5h: editingDefault || (defaultPolicy?.credits5hEnabled ?? true),
    credits7d: editingDefault || (defaultPolicy?.credits7dEnabled ?? true),
    credits30d: editingDefault || (defaultPolicy?.credits30dEnabled ?? true),
  };

  return (
    <>
      <PanelShell
        title="Limits"
        icon={<Gauge className="h-4 w-4" />}
        description={
          canViewUsage
            ? "Default inherited policy, per-user overrides, and current usage"
            : "Default inherited policy and per-user overrides"
        }
        actions={
          canManage ? (
            <Button onClick={editDefault}>
              <SlidersHorizontal />
              Configure limits
            </Button>
          ) : null
        }
      >
        <SearchFilterBar
          search={search}
          onSearchChange={setSearch}
          hasActiveFilters={Boolean(search)}
          onReset={() => setSearch("")}
          placeholder="Search users..."
          className="border-b border-border"
          inputClassName="h-12 border-0 shadow-none focus-visible:ring-inset"
        />
        <DataTable
          columns={columns}
          data={filtered}
          keyFn={(user) => user.id}
          onRowClick={canManage ? edit : undefined}
          horizontalScroll
          minWidth="58rem"
          emptyMessage="No inference users"
          embedded
          loading={loading}
        />
      </PanelShell>

      <Dialog open={limitsOpen} onOpenChange={setLimitsOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Configure Inference Limits</DialogTitle>
            <DialogDescription>Control inference access and usage budgets.</DialogDescription>
          </DialogHeader>
          <PanelShell
            title={editingDefault ? "Default policy" : editing?.name || editing?.email}
            description={
              editingDefault
                ? "Inherited by users without an individual override"
                : `Individual override for ${editing?.email ?? "this user"}`
            }
            actions={
              <Switch
                checked={form.enabled}
                onChange={(enabled) => setForm((value) => ({ ...value, enabled }))}
                ariaLabel="Inference access"
              />
            }
          >
            <LimitInput
              label="5-hour credit limit"
              value={creditLimitDraft.credits5h}
              onChange={(credits5h) => setCreditLimitDraft((value) => ({ ...value, credits5h }))}
              disabled={!form.credits5hEnabled || !globallyEnabled.credits5h}
              description={!globallyEnabled.credits5h ? "Disabled globally" : undefined}
              recoveryAt={
                form.credits5hEnabled && globallyEnabled.credits5h
                  ? editing?.usage?.recoveryAt.credits5h
                  : undefined
              }
              active={editing?.usage?.active?.credits5h}
            />
            <LimitInput
              label="Weekly credit limit"
              value={creditLimitDraft.credits7d}
              onChange={(credits7d) => setCreditLimitDraft((value) => ({ ...value, credits7d }))}
              disabled={!form.credits7dEnabled || !globallyEnabled.credits7d}
              description={!globallyEnabled.credits7d ? "Disabled globally" : undefined}
              recoveryAt={
                form.credits7dEnabled && globallyEnabled.credits7d
                  ? editing?.usage?.recoveryAt.credits7d
                  : undefined
              }
              active={editing?.usage?.active?.credits7d}
            />
            <LimitInput
              label="Monthly credit limit"
              value={creditLimitDraft.credits30d}
              onChange={(credits30d) => setCreditLimitDraft((value) => ({ ...value, credits30d }))}
              disabled={!form.credits30dEnabled || !globallyEnabled.credits30d}
              description={!globallyEnabled.credits30d ? "Disabled globally" : undefined}
              recoveryAt={
                form.credits30dEnabled && globallyEnabled.credits30d
                  ? editing?.usage?.recoveryAt.credits30d
                  : undefined
              }
              active={editing?.usage?.active?.credits30d}
            />
            <LimitInput
              label="API monthly limit · USD"
              value={apiDollars}
              onChange={(value) => {
                setApiDollars(value);
                if (value.trim() && Number(value) === 0) setApiUsageEnabled(false);
              }}
              step="0.01"
              disabled={!apiUsageEnabled}
              recoveryAt={apiUsageEnabled ? editing?.usage?.recoveryAt.apiMonthly : undefined}
              trailingControl={
                <Switch
                  checked={apiUsageEnabled}
                  onChange={(enabled) => {
                    setApiUsageEnabled(enabled);
                    setApiDollars((value) =>
                      enabled && !(parseNonNegativeNumber(value) ?? 0)
                        ? String(DEFAULT_API_MONTHLY_DOLLARS)
                        : enabled
                          ? value
                          : "0"
                    );
                  }}
                  ariaLabel="API usage enabled"
                />
              }
            />
            <SettingsControlRow
              title="Billing timezone"
              help="Defines calendar-month boundaries for the API USD budget. Fixed 5-hour, 7-day, and 30-day credit windows use their own reset anchors."
            >
              <Combobox
                value={form.billingTimezone}
                options={billingTimezoneOptions(form.billingTimezone)}
                onValueChange={(billingTimezone) =>
                  setForm((value) => ({ ...value, billingTimezone }))
                }
                freeText={false}
                ariaLabel="Billing timezone"
                placeholder="Select timezone..."
                searchPlaceholder="Search timezones..."
              />
            </SettingsControlRow>
            {editing ? (
              <SettingsControlRow
                title="Reset usage limits"
                description="Close active windows now. New subscription windows start on the user's next inference request. Limit values are unchanged."
              >
                <Button variant="outline" onClick={() => void resetLimits()} pending={resetting}>
                  Reset limits
                </Button>
              </SettingsControlRow>
            ) : null}
          </PanelShell>
          <PanelShell
            title="AI credit limits"
            description={
              editingDefault
                ? "Choose which fixed reset windows apply to every user"
                : "Further restrict fixed windows enabled by the default policy"
            }
          >
            <SubscriptionLimitToggle
              label="5 hours"
              checked={form.credits5hEnabled && globallyEnabled.credits5h}
              disabled={!globallyEnabled.credits5h}
              onChange={(credits5hEnabled) => setForm((value) => ({ ...value, credits5hEnabled }))}
            />
            <SubscriptionLimitToggle
              label="Weekly"
              checked={form.credits7dEnabled && globallyEnabled.credits7d}
              disabled={!globallyEnabled.credits7d}
              onChange={(credits7dEnabled) => setForm((value) => ({ ...value, credits7dEnabled }))}
            />
            <SubscriptionLimitToggle
              label="Monthly"
              checked={form.credits30dEnabled && globallyEnabled.credits30d}
              disabled={!globallyEnabled.credits30d}
              onChange={(credits30dEnabled) =>
                setForm((value) => ({ ...value, credits30dEnabled }))
              }
            />
          </PanelShell>
          <DialogFooter>
            {editing &&
              policies.some(
                (policy) => policy.policyType === "user" && policy.userId === editing.id
              ) && (
                <Button
                  variant="outline"
                  onClick={() => void revertToDefaultLimits()}
                  disabled={saving}
                  pending={removingOverride}
                >
                  Use default
                </Button>
              )}
            <Button variant="outline" onClick={() => setLimitsOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void save()}
              disabled={!formValid || removingOverride}
              pending={saving}
            >
              Save limits
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function LimitInput({
  label,
  value,
  onChange,
  step = "1",
  disabled = false,
  description,
  trailingControl,
  recoveryAt,
  active,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  step?: string;
  disabled?: boolean;
  description?: string;
  trailingControl?: ReactNode;
  recoveryAt?: string;
  active?: boolean;
}) {
  const resolvedDescription =
    description ??
    (active === false
      ? "Starts on next use"
      : recoveryAt
        ? `Resets ${formatDateTime(recoveryAt)}`
        : undefined);
  return (
    <SettingsControlRow
      title={label}
      description={resolvedDescription}
      controlsClassName="sm:min-w-[12rem]"
    >
      <div className="flex w-full items-center justify-end gap-2">
        <Input
          aria-label={`${label} value`}
          type="number"
          min="0"
          step={step}
          value={disabled ? "" : value}
          placeholder={disabled ? "Unlimited" : undefined}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className="h-8 sm:max-w-44"
        />
        {trailingControl}
      </div>
    </SettingsControlRow>
  );
}

function SubscriptionLimitToggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <SettingsControlRow
      title={label}
      description={disabled ? "Disabled globally" : checked ? "Enabled" : "Unlimited"}
    >
      <Switch
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        ariaLabel={`${label} limit enabled`}
      />
    </SettingsControlRow>
  );
}

function policyInput(policy: InferenceLimitPolicy): InferenceLimitInput {
  return {
    enabled: policy.enabled,
    credits5hEnabled: policy.credits5hEnabled,
    credits5h: Number(policy.credits5h),
    credits7dEnabled: policy.credits7dEnabled,
    credits7d: Number(policy.credits7d),
    credits30dEnabled: policy.credits30dEnabled,
    credits30d: Number(policy.credits30d),
    apiMonthlyMicrodollars: policy.apiMonthlyMicrodollars,
    billingTimezone: policy.billingTimezone,
  };
}

function creditLimitDraftFrom(input: InferenceLimitInput): CreditLimitDraft {
  return {
    credits5h: String(input.credits5h),
    credits7d: String(input.credits7d),
    credits30d: String(input.credits30d),
  };
}

function parseNonNegativeNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function billingTimezoneOptions(value: string): ComboboxOption[] {
  if (!value || BILLING_TIMEZONE_OPTIONS.some((option) => option.value === value)) {
    return BILLING_TIMEZONE_OPTIONS;
  }
  return [{ value, label: value }, ...BILLING_TIMEZONE_OPTIONS];
}

function budgetCell(used = 0, limit = 0, currency = false, configured = true) {
  if (!configured) {
    return (
      <div>
        <p>Unlimited</p>
        <p className="text-xs text-muted-foreground">{Math.round(used).toLocaleString()} used</p>
      </div>
    );
  }
  const percentage = limit > 0 ? Math.min(100, (used / limit) * 100) : used > 0 ? 100 : 0;
  const raw = currency
    ? `$${(used / 1_000_000).toFixed(2)} / $${(limit / 1_000_000).toFixed(2)}`
    : `${Math.round(used).toLocaleString()} / ${Math.round(limit).toLocaleString()}`;
  return (
    <div>
      <p>{Math.round(percentage)}%</p>
      <p className="text-xs text-muted-foreground">{raw}</p>
    </div>
  );
}

function policyCell(limit = 0, currency = false, configured = true) {
  if (!configured || limit <= 0) return <span>Unlimited</span>;
  return (
    <span>
      {currency ? `$${(limit / 1_000_000).toFixed(2)}` : Math.round(limit).toLocaleString()}
    </span>
  );
}
