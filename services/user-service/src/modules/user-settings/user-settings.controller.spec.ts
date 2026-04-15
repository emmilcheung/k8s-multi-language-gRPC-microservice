import { BadRequestException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserSettingsController } from "./user-settings.controller";
import { UserSettingsService } from "./user-settings.service";

function makeServiceMock() {
  return {
    getProfile: vi.fn(),
    updateProfile: vi.fn(),
    getPreferences: vi.fn(),
    updatePreferences: vi.fn(),
    getBillingAddress: vi.fn(),
    updateBillingAddress: vi.fn(),
  };
}

describe("UserSettingsController", () => {
  let service: ReturnType<typeof makeServiceMock>;
  let controller: UserSettingsController;

  beforeEach(() => {
    service = makeServiceMock();
    controller = new UserSettingsController(
      service as unknown as UserSettingsService,
    );
  });

  it("should reject missing X-User-Id on profile read", async () => {
    await expect(controller.getProfile(undefined)).rejects.toThrow(
      BadRequestException,
    );
  });

  it("should delegate profile update to service", async () => {
    const profile = {
      userId: "user-1",
      displayName: "Taylor",
      locale: "en-US",
      timezone: "UTC",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    service.updateProfile.mockResolvedValue(profile);

    const result = await controller.updateProfile("user-1", {
      displayName: "Taylor",
      locale: "en-US",
      timezone: "UTC",
    });

    expect(service.updateProfile).toHaveBeenCalledWith("user-1", {
      displayName: "Taylor",
      locale: "en-US",
      timezone: "UTC",
    });
    expect(result).toEqual({ profile });
  });

  it("should delegate preferences and billing updates", async () => {
    const preferences = {
      userId: "user-1",
      marketingOptIn: true,
      orderUpdates: true,
      productUpdates: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const billingAddress = {
      userId: "user-1",
      line1: "123 Main St",
      line2: null,
      city: "Austin",
      state: "TX",
      postalCode: "78701",
      country: "US",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    service.updatePreferences.mockResolvedValue(preferences);
    service.updateBillingAddress.mockResolvedValue(billingAddress);

    const prefResult = await controller.updatePreferences("user-1", {
      marketingOptIn: true,
      orderUpdates: true,
      productUpdates: false,
    });
    const billingResult = await controller.updateBillingAddress("user-1", {
      line1: "123 Main St",
      city: "Austin",
      state: "TX",
      postalCode: "78701",
      country: "US",
    });

    expect(prefResult).toEqual({ preferences });
    expect(billingResult).toEqual({ billingAddress });
  });
});
