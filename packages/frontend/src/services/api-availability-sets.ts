import type {
  AvailabilityEnableInput,
  AvailabilityEvent,
  AvailabilityOwner,
  AvailabilityPreflightInput,
  AvailabilityPreflightResult,
  AvailabilitySettingsInput,
  AvailabilityView,
  DashboardRelayInstance,
} from "@/types";
import { ApiRequestError } from "./api-base";
import type { ApiClientBaseConstructor } from "./api-mixins";

function availabilityPath(owner: AvailabilityOwner): string {
  const id = encodeURIComponent(owner.id);
  return owner.kind === "database"
    ? `/databases/managed/${id}/availability`
    : `/managed-storage/${id}/availability`;
}

/** Both kinds answer one page shape: `{data, page, limit}`. */
function eventRows(body: unknown): AvailabilityEvent[] {
  const rows = (body as { data?: unknown } | null)?.data;
  return Array.isArray(rows) ? (rows as AvailabilityEvent[]) : [];
}

export function withAvailabilitySetsApi<TBase extends ApiClientBaseConstructor>(Base: TBase) {
  return class AvailabilitySetsApiClient extends Base {
    /** The availability view, or null when the resource runs on one server. */
    async getAvailability(owner: AvailabilityOwner): Promise<AvailabilityView | null> {
      try {
        return await this.unwrapData(
          this.request<{ data: AvailabilityView }>(availabilityPath(owner))
        );
      } catch (error) {
        if (
          error instanceof ApiRequestError &&
          error.status === 404 &&
          error.code === "AVAILABILITY_SET_NOT_FOUND"
        ) {
          return null;
        }
        throw error;
      }
    }

    async preflightAvailability(
      owner: AvailabilityOwner,
      input: AvailabilityPreflightInput
    ): Promise<AvailabilityPreflightResult> {
      return this.unwrapData(
        this.request<{ data: AvailabilityPreflightResult }>(
          `${availabilityPath(owner)}/preflight`,
          { method: "POST", body: JSON.stringify(input) }
        )
      );
    }

    /** Preflight of the create form (the resource does not exist yet). */
    async preflightAvailabilityForCreate(
      kind: AvailabilityOwner["kind"],
      input: AvailabilityPreflightInput & Record<string, unknown>
    ): Promise<AvailabilityPreflightResult> {
      const path =
        kind === "database"
          ? "/databases/managed/availability/preflight"
          : "/managed-storage/availability/preflight";
      return this.unwrapData(
        this.request<{ data: AvailabilityPreflightResult }>(path, {
          method: "POST",
          body: JSON.stringify(input),
        })
      );
    }

    /** Turns a single-server resource into an availability set. */
    async enableAvailability(
      owner: AvailabilityOwner,
      input: AvailabilityEnableInput
    ): Promise<unknown> {
      return this.unwrapData(
        this.request<{ data: unknown }>(availabilityPath(owner), {
          method: "POST",
          body: JSON.stringify(input),
        })
      );
    }

    async updateAvailabilitySettings(
      owner: AvailabilityOwner,
      input: AvailabilitySettingsInput
    ): Promise<unknown> {
      return this.unwrapData(
        this.request<{ data: unknown }>(availabilityPath(owner), {
          method: "PATCH",
          body: JSON.stringify(input),
        })
      );
    }

    /** Back to one server: the primary stays, the copies go. */
    async disableAvailability(
      owner: AvailabilityOwner,
      input?: { keepMemberId?: string; force?: boolean }
    ): Promise<unknown> {
      return this.unwrapData(
        this.request<{ data: unknown }>(availabilityPath(owner), {
          method: "DELETE",
          ...(input ? { body: JSON.stringify(input) } : {}),
        })
      );
    }

    async addAvailabilityMember(owner: AvailabilityOwner, nodeId: string): Promise<unknown> {
      return this.unwrapData(
        this.request<{ data: unknown }>(`${availabilityPath(owner)}/members`, {
          method: "POST",
          body: JSON.stringify({ nodeId }),
        })
      );
    }

    async removeAvailabilityMember(owner: AvailabilityOwner, memberId: string): Promise<unknown> {
      return this.unwrapData(
        this.request<{ data: unknown }>(
          `${availabilityPath(owner)}/members/${encodeURIComponent(memberId)}`,
          { method: "DELETE" }
        )
      );
    }

    async rebuildAvailabilityMember(owner: AvailabilityOwner, memberId: string): Promise<unknown> {
      return this.unwrapData(
        this.request<{ data: unknown }>(
          `${availabilityPath(owner)}/members/${encodeURIComponent(memberId)}/rebuild`,
          { method: "POST" }
        )
      );
    }

    /** Planned switchover; a promotion that may lose writes needs `acceptDataLoss`. */
    async makeAvailabilityPrimary(
      owner: AvailabilityOwner,
      memberId: string,
      acceptDataLoss = false
    ): Promise<unknown> {
      return this.unwrapData(
        this.request<{ data: unknown }>(`${availabilityPath(owner)}/make-primary`, {
          method: "POST",
          body: JSON.stringify(acceptDataLoss ? { memberId, acceptDataLoss } : { memberId }),
        })
      );
    }

    async listAvailabilityEvents(
      owner: AvailabilityOwner,
      params: { page?: number; limit?: number } = {}
    ): Promise<AvailabilityEvent[]> {
      const query = new URLSearchParams({
        page: String(params.page ?? 1),
        limit: String(params.limit ?? 20),
      });
      const body = await this.request<unknown>(`${availabilityPath(owner)}/events?${query}`);
      return eventRows(body);
    }

    /** Whether availability witnesses may run on a relay (admin flag). */
    async setRelayWitnessHosting(
      instanceId: string,
      witnessHostingAllowed: boolean
    ): Promise<DashboardRelayInstance> {
      return this.unwrapData(
        this.request<{ data: DashboardRelayInstance }>(
          `/system/relay/instances/${encodeURIComponent(instanceId)}`,
          { method: "PATCH", body: JSON.stringify({ witnessHostingAllowed }) }
        )
      );
    }
  };
}
