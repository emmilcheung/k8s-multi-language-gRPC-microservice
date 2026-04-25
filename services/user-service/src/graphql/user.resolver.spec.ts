import { describe, it, expect, vi, beforeEach } from "vitest";
import { UserResolver } from "./user.resolver";
import { UserLoader } from "./users.loader";

describe("UserResolver", () => {
  let resolver: UserResolver;
  const mockUserSettingsService = {
    getProfile: vi.fn(),
    getPreferences: vi.fn(),
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
});
