import { describe, it, expect, beforeEach, vi } from "vitest";
import { UserSettingsService } from "./user-settings.service";
import { UserSettingsRepository } from "./user-settings.repository";

function makeRepositoryMock() {
  return {
    getOrCreateProfile: vi.fn(),
    upsertProfile: vi.fn(),
    getOrCreatePreferences: vi.fn(),
    upsertPreferences: vi.fn(),
    getOrCreateBillingAddress: vi.fn(),
    upsertBillingAddress: vi.fn(),
  };
}

describe("UserSettingsService", () => {
  let repository: ReturnType<typeof makeRepositoryMock>;
  let service: UserSettingsService;

  beforeEach(() => {
    repository = makeRepositoryMock();
    service = new UserSettingsService(
      repository as unknown as UserSettingsRepository,
    );
  });

  it("getProfile should return lazily created profile from repository", async () => {
    const profile = {
      userId: "user-1",
      displayName: null,
      locale: null,
      timezone: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    repository.getOrCreateProfile.mockResolvedValue(profile);

    const result = await service.getProfile("user-1");

    expect(repository.getOrCreateProfile).toHaveBeenCalledWith("user-1");
    expect(result).toEqual(profile);
  });

  it("updateProfile should upsert and return profile", async () => {
    const updated = {
      userId: "user-1",
      displayName: "Taylor",
      locale: "en-US",
      timezone: "UTC",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    repository.upsertProfile.mockResolvedValue(updated);

    const result = await service.updateProfile("user-1", {
      displayName: "Taylor",
      locale: "en-US",
      timezone: "UTC",
    });

    expect(repository.upsertProfile).toHaveBeenCalledWith("user-1", {
      displayName: "Taylor",
      locale: "en-US",
      timezone: "UTC",
    });
    expect(result).toEqual(updated);
  });

  it("getPreferences should return lazily created defaults from repository", async () => {
    const preferences = {
      userId: "user-1",
      marketingOptIn: false,
      orderUpdates: true,
      productUpdates: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    repository.getOrCreatePreferences.mockResolvedValue(preferences);

    const result = await service.getPreferences("user-1");

    expect(repository.getOrCreatePreferences).toHaveBeenCalledWith("user-1");
    expect(result).toEqual(preferences);
  });

  it("updatePreferences should upsert and return preferences", async () => {
    const updated = {
      userId: "user-1",
      marketingOptIn: true,
      orderUpdates: false,
      productUpdates: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    repository.upsertPreferences.mockResolvedValue(updated);

    const result = await service.updatePreferences("user-1", {
      marketingOptIn: true,
      orderUpdates: false,
      productUpdates: true,
    });

    expect(repository.upsertPreferences).toHaveBeenCalledWith("user-1", {
      marketingOptIn: true,
      orderUpdates: false,
      productUpdates: true,
    });
    expect(result).toEqual(updated);
  });

  it("getBillingAddress should return lazily created address from repository", async () => {
    const address = {
      userId: "user-1",
      line1: null,
      line2: null,
      city: null,
      state: null,
      postalCode: null,
      country: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    repository.getOrCreateBillingAddress.mockResolvedValue(address);

    const result = await service.getBillingAddress("user-1");

    expect(repository.getOrCreateBillingAddress).toHaveBeenCalledWith("user-1");
    expect(result).toEqual(address);
  });

  it("updateBillingAddress should upsert and return address", async () => {
    const updated = {
      userId: "user-1",
      line1: "123 Main St",
      line2: "Unit 4",
      city: "Austin",
      state: "TX",
      postalCode: "78701",
      country: "US",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    repository.upsertBillingAddress.mockResolvedValue(updated);

    const result = await service.updateBillingAddress("user-1", {
      line1: "123 Main St",
      line2: "Unit 4",
      city: "Austin",
      state: "TX",
      postalCode: "78701",
      country: "US",
    });

    expect(repository.upsertBillingAddress).toHaveBeenCalledWith("user-1", {
      line1: "123 Main St",
      line2: "Unit 4",
      city: "Austin",
      state: "TX",
      postalCode: "78701",
      country: "US",
    });
    expect(result).toEqual(updated);
  });
});
