import { describe, expect, it } from "vitest";
import {
  EMPTY_MODEL_PRICING,
  hasValidPricing,
  pricingFromModel,
  pricingPayload,
} from "./inference-model-form";

describe("API model pricing form", () => {
  it("lets a model be saved without a price and sends no pricing for it", () => {
    expect(hasValidPricing(EMPTY_MODEL_PRICING)).toBe(true);
    expect(pricingPayload(EMPTY_MODEL_PRICING)).toBeUndefined();
  });

  it("needs both token prices once any price is set", () => {
    expect(hasValidPricing({ ...EMPTY_MODEL_PRICING, inputPrice: "1" })).toBe(false);
    expect(hasValidPricing({ ...EMPTY_MODEL_PRICING, imagePrice: "0.04" })).toBe(false);
    expect(hasValidPricing({ ...EMPTY_MODEL_PRICING, inputPrice: "1", outputPrice: "-1" })).toBe(
      false
    );
    expect(hasValidPricing({ ...EMPTY_MODEL_PRICING, inputPrice: "0", outputPrice: "0" })).toBe(
      true
    );
  });

  it("saves only the per-call prices that are set", () => {
    const payload = pricingPayload({
      ...EMPTY_MODEL_PRICING,
      inputPrice: "2.8",
      outputPrice: "8.8",
      imagePrice: "0.04",
    });
    expect(payload).toMatchObject({
      inputMicrodollarsPerMillion: 2_800_000,
      outputMicrodollarsPerMillion: 8_800_000,
      otherUnitPrices: { image_generation: 40_000, image_edit: 40_000 },
      source: "manual",
    });
    expect(Object.keys(payload!.otherUnitPrices)).toEqual(["image_generation", "image_edit"]);
  });

  it("shows a missing price as empty, not as $0", () => {
    expect(pricingFromModel(null)).toEqual(EMPTY_MODEL_PRICING);
    const form = pricingFromModel({
      sources: [
        {
          pricing: {
            inputMicrodollarsPerMillion: null,
            outputMicrodollarsPerMillion: null,
            otherUnitPrices: {},
          },
        },
      ],
    } as never);
    expect(form).toEqual(EMPTY_MODEL_PRICING);
  });
});
