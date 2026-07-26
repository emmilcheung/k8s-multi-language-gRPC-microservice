import { describe, it, expect, vi, beforeEach } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import {
  UserResolver,
  UserSettingsMutationResolver,
  UserProfileResolver,
} from "./user.resolver";
import { UserLoader } from "./users.loader";

describe("UserResolver", () => {
  let resolver: UserResolver;
  const mockUserSettingsService = {
    getProfile: vi.fn(),
    getPreferences: vi.fn(),
    getBillingAddress: vi.fn(),
  };

  const mockUserLoader = {
    load: vi.fn((id: string) => Promise.resolve({ id })),
  } as unknown as UserLoader;

  beforeEach(() => {
    resolver = new UserResolver(mockUserSettingsService as any, mockUserLoader);
    vi.clearAllMocks();
  });

  describe("resolveReference", () => {
    it("returns user stub with id for federation", async () => {
      const result = await resolver.resolveReference({
        __typename: "User",
        id: "user-123",
      });
      expect(result).toEqual({ id: "user-123" });
    });
  });

  describe("profile", () => {
    it("returns profile when requester is self", async () => {
      const profile = { displayName: "Jane", locale: "en-US", timezone: "UTC" };
      mockUserSettingsService.getProfile.mockResolvedValue(profile);

      const ctx = { req: { headers: { "x-user-id": "user-123" } } };
      const result = await resolver.profile({ id: "user-123" }, ctx as any);

      expect(result).toEqual(profile);
    });

    it("returns null when requester is not self", async () => {
      const ctx = { req: { headers: { "x-user-id": "other-user" } } };
      const result = await resolver.profile({ id: "user-123" }, ctx as any);

      expect(result).toBeNull();
      expect(mockUserSettingsService.getProfile).not.toHaveBeenCalled();
    });
  });

  describe("preferences", () => {
    it("returns preferences when requester is self", async () => {
      const prefs = {
        marketingOptIn: true,
        orderUpdates: true,
        productUpdates: false,
      };
      mockUserSettingsService.getPreferences.mockResolvedValue(prefs);

      const ctx = { req: { headers: { "x-user-id": "user-123" } } };
      const result = await resolver.preferences({ id: "user-123" }, ctx as any);

      expect(result).toEqual(prefs);
    });

    it("returns null when requester is not self", async () => {
      const ctx = { req: { headers: { "x-user-id": "other-user" } } };
      const result = await resolver.preferences({ id: "user-123" }, ctx as any);

      expect(result).toBeNull();
    });
  });

  describe("billingAddress", () => {
    it("returns billing address when requester is self", async () => {
      const addr = { line1: "1 Main St", city: "NYC", country: "US" };
      mockUserSettingsService.getBillingAddress.mockResolvedValue(addr);

      const ctx = { req: { headers: { "x-user-id": "user-123" } } };
      const result = await resolver.billingAddress(
        { id: "user-123" },
        ctx as any,
      );

      expect(result).toEqual(addr);
    });

    it("returns null when requester is not self", async () => {
      const ctx = { req: { headers: { "x-user-id": "other-user" } } };
      const result = await resolver.billingAddress(
        { id: "user-123" },
        ctx as any,
      );

      expect(result).toBeNull();
      expect(mockUserSettingsService.getBillingAddress).not.toHaveBeenCalled();
    });
  });
});

describe("UserSettingsMutationResolver", () => {
  const mockService = {
    updateProfile: vi.fn(),
    updatePreferences: vi.fn(),
    updateBillingAddress: vi.fn(),
  };
  let resolver: UserSettingsMutationResolver;

  beforeEach(() => {
    resolver = new UserSettingsMutationResolver(mockService as any);
    vi.clearAllMocks();
  });

  it("updateProfile delegates with caller id", async () => {
    mockService.updateProfile.mockResolvedValue({ displayName: "Jane" });
    const ctx = { req: { headers: { "x-user-id": "u-1" } } };
    const out = await resolver.updateProfile(
      { displayName: "Jane" },
      ctx as any,
    );
    expect(mockService.updateProfile).toHaveBeenCalledWith("u-1", {
      displayName: "Jane",
    });
    expect(out).toEqual({ displayName: "Jane" });
  });

  it("updatePreferences delegates with caller id", async () => {
    mockService.updatePreferences.mockResolvedValue({ marketingOptIn: true });
    const ctx = { req: { headers: { "x-user-id": "u-2" } } };
    await resolver.updatePreferences({ marketingOptIn: true }, ctx as any);
    expect(mockService.updatePreferences).toHaveBeenCalledWith("u-2", {
      marketingOptIn: true,
    });
  });

  it("updateBillingAddress delegates with caller id", async () => {
    mockService.updateBillingAddress.mockResolvedValue({ line1: "1 Main St" });
    const ctx = { req: { headers: { "x-user-id": "u-3" } } };
    await resolver.updateBillingAddress({ line1: "1 Main St" }, ctx as any);
    expect(mockService.updateBillingAddress).toHaveBeenCalledWith("u-3", {
      line1: "1 Main St",
    });
  });

  it("throws ForbiddenException when X-User-Id missing", () => {
    const ctx = { req: { headers: {} } };
    expect(() =>
      resolver.updateProfile({ displayName: "x" } as any, ctx as any),
    ).toThrow(ForbiddenException);
  });
});

describe("UserProfileResolver", () => {
  const mockService = { getBillingAddress: vi.fn() };
  let resolver: UserProfileResolver;

  beforeEach(() => {
    resolver = new UserProfileResolver(mockService as any);
    vi.clearAllMocks();
  });

  it("returns billing address for the caller", async () => {
    mockService.getBillingAddress.mockResolvedValue({ line1: "addr" });
    const ctx = { req: { headers: { "x-user-id": "u-1" } } };
    const out = await resolver.billingAddress(ctx as any);
    expect(out).toEqual({ line1: "addr" });
  });

  it("returns null when X-User-Id missing", async () => {
    const ctx = { req: { headers: {} } };
    const out = await resolver.billingAddress(ctx as any);
    expect(out).toBeNull();
  });
});
