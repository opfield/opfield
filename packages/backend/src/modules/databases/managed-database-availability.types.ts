import type { AvailabilityPrimaryAssignment, CommandResult } from '@/grpc/generated/types.js';
import type { ManagedAvailabilitySetLease } from '@/modules/docker/availability/lease/availability-lease.service.js';
import type { ManagedAvailabilitySetController } from '@/modules/docker/availability/lease/managed-availability-lease-source.js';

/**
 * What the commercial control plane of database and storage availability sets uses from the open-core host. Gateway's
 * bootstrap hands it over with `ManagedDatabaseService.setAvailabilityHost` and `ManagedStorageService.setAvailabilityHost`
 * (parts may arrive in several calls; the services merge them).
 */
export interface ManagedAvailabilityHost {
  /** The lease host's set contract (P1-T03). */
  lease: ManagedAvailabilityLeasePort;
  /** Member configuration and reports (AvailabilityMembersService). */
  members: ManagedAvailabilityMembersPort;
  /** Signs manual pairs' primary assignments with the relay policy key. */
  signer: ManagedAvailabilityAssignmentSigner;
  /** Relay paths of sets (P1-T05). */
  relay: ManagedAvailabilityRelayPort;
  /** Settings the preflight shows (decision 18: the relay policy envelope bounds Gateway-down operation). */
  settings: { relayPolicyLeaseHours(): Promise<number> };
  /** Witness processes relays host for sets (RelayWitnessService): pushed again after witness rows changed. */
  witnesses: ManagedAvailabilityWitnessPort;
}

export interface ManagedAvailabilityWitnessPort {
  syncSet(setId: string): Promise<void>;
}

export interface ManagedAvailabilityLeasePort {
  createSetPolicy(setId: string): Promise<{ leasePolicyId: string }>;
  updateSetVoters(setId: string): Promise<void>;
  closeSetPolicy(setId: string): Promise<void>;
  observeSet(setId: string, now?: Date): Promise<ManagedAvailabilitySetLease>;
  attachSetController(controller: ManagedAvailabilitySetController): void;
  /** Marks the next holder change of the set's key as planned, so it is audited as a switchover. */
  registerPlannedHandoff(
    leasePolicyId: string,
    input: {
      slot: number;
      fromHolderId: string | null;
      toHolderId: string;
      operationId?: string | null;
      ttlMs?: number;
    }
  ): Promise<void>;
}

/** A member event as the node queued it (the time it happened on the data plane). */
export interface ManagedAvailabilityMemberEvent {
  sequence: number;
  kind: string;
  at: Date;
  reason: string | null;
  operationId: string | null;
  detail: Record<string, string>;
}

export interface ManagedAvailabilitySetRef {
  id: string;
  ownerKind: string;
  ownerId: string;
  engine: string;
}

export interface ManagedAvailabilityMemberRef {
  id: string;
  setId: string;
  nodeId: string;
}

export interface ManagedAvailabilityMembersPort {
  registerEngineConfig(
    engine: 'postgres' | 'valkey' | 'clickhouse' | 'seaweedfs',
    provider: (
      setId: string,
      memberId: string
    ) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined
  ): void;
  onMemberEvents(
    listener: (
      set: ManagedAvailabilitySetRef,
      member: ManagedAvailabilityMemberRef,
      events: ManagedAvailabilityMemberEvent[]
    ) => Promise<void>
  ): void;
  onPrimaryChanged(
    listener: (
      set: ManagedAvailabilitySetRef,
      member: ManagedAvailabilityMemberRef,
      previousMemberId: string | null
    ) => Promise<void> | void
  ): void;
  /** Sends the current configuration to every member (bump config_revision first); returns members not configured. */
  configureSet(setId: string, onlyMemberId?: string): Promise<string[]>;
  removeMember(setId: string, memberId: string, nodeId: string): Promise<CommandResult | null>;
  assignPrimary(setId: string, assignment: AvailabilityPrimaryAssignment): Promise<string[]>;
  switchover(
    setId: string,
    holderNodeId: string,
    successorMemberId: string,
    operationId: string
  ): Promise<CommandResult | null>;
}

export interface ManagedAvailabilityAssignmentSigner {
  signPrimaryAssignment(input: {
    setId: string;
    primaryMemberId: string;
    generation: number | bigint;
  }): Promise<AvailabilityPrimaryAssignment>;
}

export interface ManagedAvailabilityRelayPort {
  /** Member endpoints and routes follow the set's members and mode (after every switch and member change). */
  reconcileSetRelayPaths(setId: string): Promise<void>;
  /** Before a set is deleted: the kept member's paths become the single-node paths in place. */
  releaseSetRelayPaths(setId: string, keepMemberId: string): Promise<void>;
}
