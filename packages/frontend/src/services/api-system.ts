import type {
  CloudConnectCodeView,
  CloudLinkStatusView,
  DaemonNodeUpdateResult,
  DaemonUpdateStatus,
  DashboardRelaySnapshot,
  HousekeepingConfig,
  HousekeepingRunResult,
  HousekeepingStats,
  LicenseStatusView,
  RelayRebalanceOutcome,
  RelayReenrollment,
  SystemConfig,
  UpdateStatus,
} from "@/types";
import type { ApiClientBaseConstructor } from "./api-mixins";

export function withSystemApi<TBase extends ApiClientBaseConstructor>(Base: TBase) {
  return class SystemApiClient extends Base {
    async getVersionInfo(): Promise<UpdateStatus> {
      return this.unwrapData(this.request<{ data: UpdateStatus }>("/system/version"));
    }

    async getSystemConfig(): Promise<SystemConfig> {
      return this.unwrapData(this.request<{ data: SystemConfig }>("/system/config"));
    }

    async retryRelayRecovery(): Promise<DashboardRelaySnapshot> {
      return this.unwrapData(
        this.request<{ data: DashboardRelaySnapshot }>("/system/relay/recovery", { method: "POST" })
      );
    }

    async getRelayStatus(): Promise<DashboardRelaySnapshot | null> {
      return this.unwrapData(
        this.request<{ data: DashboardRelaySnapshot | null }>("/system/relay")
      );
    }

    async rebalanceRelayPool(): Promise<RelayRebalanceOutcome[]> {
      return this.unwrapData(
        this.request<{ data: RelayRebalanceOutcome[] }>("/system/relay/rebalance", {
          method: "POST",
        })
      );
    }

    async setRelayInstanceDrain(
      instanceId: string,
      enabled: boolean
    ): Promise<DashboardRelaySnapshot> {
      const action = enabled ? "drain" : "resume";
      return this.unwrapData(
        this.request<{ data: DashboardRelaySnapshot }>(
          `/system/relay/instances/${instanceId}/${action}`,
          {
            method: "POST",
            ...(enabled ? { body: JSON.stringify({ confirm: true }) } : {}),
          }
        )
      );
    }

    async forceDisconnectRelayInstance(instanceId: string): Promise<DashboardRelaySnapshot> {
      return this.unwrapData(
        this.request<{ data: DashboardRelaySnapshot }>(
          `/system/relay/instances/${instanceId}/force-disconnect`,
          { method: "POST", body: JSON.stringify({ confirm: true }) }
        )
      );
    }

    /** Renew a remote relay's server certificate now. */
    async renewRelayInstanceCertificate(instanceId: string): Promise<DashboardRelaySnapshot> {
      return this.unwrapData(
        this.request<{ data: DashboardRelaySnapshot }>(
          `/system/relay/instances/${instanceId}/renew-certificate`,
          { method: "POST" }
        )
      );
    }

    /** Issue a single-use token that re-enrolls an enrolled remote relay. */
    async reenrollRelayInstance(instanceId: string): Promise<RelayReenrollment> {
      return this.unwrapData(
        this.request<{ data: RelayReenrollment }>(
          `/system/relay/instances/${instanceId}/reenroll`,
          {
            method: "POST",
            body: JSON.stringify({ confirm: true }),
          }
        )
      );
    }

    async checkForUpdates(): Promise<UpdateStatus> {
      return this.unwrapData(
        this.request<{ data: UpdateStatus }>("/system/check-update", { method: "POST" })
      );
    }

    async triggerUpdate(version: string): Promise<{ status: string; targetVersion: string }> {
      return this.unwrapData(
        this.request<{ data: { status: string; targetVersion: string } }>("/system/update", {
          method: "POST",
          body: JSON.stringify({ version }),
        })
      );
    }

    /** Update now instead of waiting for running orchestration operations. */
    async proceedWithUpdate(): Promise<{ status: string }> {
      return this.unwrapData(
        this.request<{ data: { status: string } }>("/system/update/proceed", { method: "POST" })
      );
    }

    /** Stop reporting a Gateway update that was rolled back. */
    async acknowledgeUpdateFailure(): Promise<{ acknowledged: boolean }> {
      return this.unwrapData(
        this.request<{ data: { acknowledged: boolean } }>("/system/update/acknowledge", {
          method: "POST",
        })
      );
    }

    async triggerRelayUpdate(version: string): Promise<{ status: string; targetVersion: string }> {
      return this.unwrapData(
        this.request<{ data: { status: string; targetVersion: string } }>("/system/relay-update", {
          method: "POST",
          body: JSON.stringify({ version }),
        })
      );
    }

    /** Fail a stuck or paused Relay Pool update and resume the relays it drained. */
    async abandonRelayUpdate(): Promise<{ targetVersion: string | null }> {
      return this.unwrapData(
        this.request<{ data: { targetVersion: string | null } }>("/system/relay-update/abandon", {
          method: "POST",
        })
      );
    }

    async getReleaseNotes(version: string): Promise<string> {
      const result = await this.unwrapData(
        this.request<{ data: { version: string; notes: string } }>(
          `/system/release-notes/${encodeURIComponent(version)}`
        )
      );
      return result.notes;
    }

    async getAllReleaseNotes(): Promise<{ version: string; notes: string }[]> {
      return this.unwrapData(
        this.request<{ data: { version: string; notes: string }[] }>("/system/release-notes")
      );
    }

    // ── Daemon Updates ──────────────────────────────────────────────

    async getDaemonUpdates(): Promise<DaemonUpdateStatus[]> {
      return this.unwrapData(
        this.request<{ data: DaemonUpdateStatus[] }>("/system/daemon-updates")
      );
    }

    async checkDaemonUpdates(): Promise<DaemonUpdateStatus[]> {
      return this.unwrapData(
        this.request<{ data: DaemonUpdateStatus[] }>("/system/daemon-updates/check", {
          method: "POST",
        })
      );
    }

    /** `now` updates without waiting for the node's running tasks, also an update already waiting for them. */
    async triggerDaemonUpdate(
      nodeId: string,
      options: { now?: boolean } = {}
    ): Promise<DaemonNodeUpdateResult> {
      return this.unwrapData(
        this.request<{ data: DaemonNodeUpdateResult }>(`/system/daemon-updates/${nodeId}`, {
          method: "POST",
          ...(options.now ? { body: JSON.stringify({ now: true }) } : {}),
        })
      );
    }

    // ── Cloud ───────────────────────────────────────────────────────

    async getCloudLinkStatus(): Promise<CloudLinkStatusView> {
      return this.unwrapData(this.request<{ data: CloudLinkStatusView }>("/system/cloud/status"));
    }

    async connectCloud(code: string): Promise<CloudLinkStatusView> {
      return this.unwrapData(
        this.request<{ data: CloudLinkStatusView }>("/system/cloud/connect", {
          method: "POST",
          body: JSON.stringify({ code }),
        })
      );
    }

    /** A code to enter in the Opfield account; Gateway waits for it to be entered. */
    async startCloudLinkCode(): Promise<CloudConnectCodeView> {
      return this.unwrapData(
        this.request<{ data: CloudConnectCodeView }>("/system/cloud/link", { method: "POST" })
      );
    }

    async getCloudLinkCode(): Promise<CloudConnectCodeView> {
      return this.unwrapData(this.request<{ data: CloudConnectCodeView }>("/system/cloud/link"));
    }

    async cancelCloudLinkCode(): Promise<CloudConnectCodeView> {
      return this.unwrapData(
        this.request<{ data: CloudConnectCodeView }>("/system/cloud/link/cancel", {
          method: "POST",
        })
      );
    }

    async setCloudRemoteManagement(enabled: boolean): Promise<CloudLinkStatusView> {
      return this.unwrapData(
        this.request<{ data: CloudLinkStatusView }>("/system/cloud/remote-management", {
          method: "POST",
          body: JSON.stringify({ enabled }),
        })
      );
    }

    async disconnectCloud(): Promise<CloudLinkStatusView> {
      return this.unwrapData(
        this.request<{ data: CloudLinkStatusView }>("/system/cloud/disconnect", { method: "POST" })
      );
    }

    // ── License ─────────────────────────────────────────────────────

    async getLicenseStatus(): Promise<LicenseStatusView> {
      return this.unwrapData(this.request<{ data: LicenseStatusView }>("/system/license/status"));
    }

    async activateLicense(licenseKey: string): Promise<LicenseStatusView> {
      return this.unwrapData(
        this.request<{ data: LicenseStatusView }>("/system/license/activate", {
          method: "POST",
          body: JSON.stringify({ licenseKey }),
        })
      );
    }

    async checkLicense(): Promise<LicenseStatusView> {
      return this.unwrapData(
        this.request<{ data: LicenseStatusView }>("/system/license/check", { method: "POST" })
      );
    }

    async activateLicenseModule(): Promise<{ restarting: boolean }> {
      return this.unwrapData(
        this.request<{ data: { restarting: boolean } }>("/system/license/module/activate", {
          method: "POST",
        })
      );
    }

    async clearLicenseKey(): Promise<LicenseStatusView> {
      return this.unwrapData(
        this.request<{ data: LicenseStatusView }>("/system/license/key", { method: "DELETE" })
      );
    }

    // ── Housekeeping ────────────────────────────────────────────────

    async getHousekeepingConfig(): Promise<HousekeepingConfig> {
      return this.unwrapData(this.request<{ data: HousekeepingConfig }>("/housekeeping/config"));
    }

    async updateHousekeepingConfig(
      config: Partial<HousekeepingConfig>
    ): Promise<HousekeepingConfig> {
      return this.unwrapData(
        this.request<{ data: HousekeepingConfig }>("/housekeeping/config", {
          method: "PUT",
          body: JSON.stringify(config),
        })
      );
    }

    async getHousekeepingStats(): Promise<HousekeepingStats> {
      return this.unwrapData(this.request<{ data: HousekeepingStats }>("/housekeeping/stats"));
    }

    async runHousekeeping(): Promise<HousekeepingRunResult> {
      return this.unwrapData(
        this.request<{ data: HousekeepingRunResult }>("/housekeeping/run", { method: "POST" })
      );
    }

    async getHousekeepingHistory(): Promise<HousekeepingRunResult[]> {
      return this.unwrapData(
        this.request<{ data: HousekeepingRunResult[] }>("/housekeeping/history")
      );
    }
  };
}
