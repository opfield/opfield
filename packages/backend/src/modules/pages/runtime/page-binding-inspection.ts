import type { PagesPreviewClientIp } from '@/grpc/generated/types.js';

export interface PageBindingExpectation {
  kind: 'preview' | 'route';
  id: string;
  deploymentId: string;
  sha256: string;
  size: number;
  generation: number;
  runtimeConfig: Record<string, unknown>;
  certificateId?: string;
  certificateVersion?: string;
  spaFallback?: boolean;
  fallbackUrl?: string;
  clientIp?: PagesPreviewClientIp;
  stateGeneration: number;
}
export type PageBindingInspection = Map<
  string,
  {
    expectation: PageBindingExpectation;
    matches: boolean;
  }
>;
