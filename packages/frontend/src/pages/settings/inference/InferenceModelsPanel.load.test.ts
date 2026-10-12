import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/api", () => ({ api: {} }));

import { ApiRequestError } from "@/services/api-base";
import { loadInferenceModelsPanelData } from "./InferenceModelsPanel";

const model = { id: "m1", displayName: "Model", publicId: "model" };
const forbidden = () =>
  new ApiRequestError("Missing inference:providers:view", { status: 403, code: "FORBIDDEN" });

function client(overrides: Record<string, () => Promise<unknown>> = {}) {
  return {
    listInferenceModels: vi.fn(async () => [model]),
    listInferenceProviderConnections: vi.fn(async () => [{ id: "c1" }]),
    listInferenceProviderCatalog: vi.fn(async () => [{ id: "openai", label: "OpenAI" }]),
    listGroups: vi.fn(async () => []),
    listUsers: vi.fn(async () => []),
    ...overrides,
  } as unknown as Parameters<typeof loadInferenceModelsPanelData>[0];
}

describe("loadInferenceModelsPanelData", () => {
  it("does not request providers without inference:providers:view and still lists models", async () => {
    const api = client();
    const data = await loadInferenceModelsPanelData(api, {
      canViewProviders: false,
      canListGroups: false,
      canListUsers: false,
    });
    expect(api.listInferenceProviderConnections).not.toHaveBeenCalled();
    expect(api.listInferenceProviderCatalog).not.toHaveBeenCalled();
    expect(api.listGroups).not.toHaveBeenCalled();
    expect(data.models).toEqual([model]);
    expect(data.connections).toEqual([]);
    expect(data.modelsError).toBeUndefined();
  });

  it("keeps the models when the provider lists are refused", async () => {
    const api = client({
      listInferenceProviderConnections: async () => Promise.reject(forbidden()),
      listInferenceProviderCatalog: async () => Promise.reject(forbidden()),
    });
    const data = await loadInferenceModelsPanelData(api, {
      canViewProviders: true,
      canListGroups: true,
      canListUsers: true,
    });
    expect(data.models).toEqual([model]);
    expect(data.connections).toBeNull();
    expect(data.catalog).toBeNull();
    expect(data.groups).toEqual([]);
  });

  it("reports a failed models request for the inline state", async () => {
    const error = forbidden();
    const data = await loadInferenceModelsPanelData(
      client({ listInferenceModels: async () => Promise.reject(error) }),
      { canViewProviders: true, canListGroups: false, canListUsers: false }
    );
    expect(data.models).toBeNull();
    expect(data.modelsError).toBe(error);
    expect(data.connections).toEqual([{ id: "c1" }]);
  });
});
