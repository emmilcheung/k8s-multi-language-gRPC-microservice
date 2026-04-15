import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import {
  billingAddresses,
  type BillingAddress,
  userPreferences,
  type UserPreferences,
  userProfiles,
  type UserProfile,
} from "../../database/schema";
import { DRIZZLE_DB, type DrizzleDB } from "../../database/database.module";
import {
  type UpdateBillingAddressDto,
  type UpdatePreferencesDto,
  type UpdateProfileDto,
} from "./user-settings.dto";

@Injectable()
export class UserSettingsRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDB) {}

  async getOrCreateProfile(userId: string): Promise<UserProfile> {
    const [existing] = await this.db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId))
      .limit(1);

    if (existing) return existing;

    await this.db.insert(userProfiles).values({ userId }).onConflictDoNothing();

    const [created] = await this.db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId))
      .limit(1);

    return created;
  }

  async upsertProfile(
    userId: string,
    dto: UpdateProfileDto,
  ): Promise<UserProfile> {
    const now = new Date();

    const [profile] = await this.db
      .insert(userProfiles)
      .values({
        userId,
        displayName: dto.displayName,
        locale: dto.locale,
        timezone: dto.timezone,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: userProfiles.userId,
        set: {
          displayName: dto.displayName,
          locale: dto.locale,
          timezone: dto.timezone,
          updatedAt: now,
        },
      })
      .returning();

    return profile;
  }

  async getOrCreatePreferences(userId: string): Promise<UserPreferences> {
    const [existing] = await this.db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1);

    if (existing) return existing;

    await this.db
      .insert(userPreferences)
      .values({ userId })
      .onConflictDoNothing();

    const [created] = await this.db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1);

    return created;
  }

  async upsertPreferences(
    userId: string,
    dto: UpdatePreferencesDto,
  ): Promise<UserPreferences> {
    const now = new Date();

    const [preferences] = await this.db
      .insert(userPreferences)
      .values({
        userId,
        marketingOptIn: dto.marketingOptIn,
        orderUpdates: dto.orderUpdates,
        productUpdates: dto.productUpdates,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: {
          marketingOptIn: dto.marketingOptIn,
          orderUpdates: dto.orderUpdates,
          productUpdates: dto.productUpdates,
          updatedAt: now,
        },
      })
      .returning();

    return preferences;
  }

  async getOrCreateBillingAddress(userId: string): Promise<BillingAddress> {
    const [existing] = await this.db
      .select()
      .from(billingAddresses)
      .where(eq(billingAddresses.userId, userId))
      .limit(1);

    if (existing) return existing;

    await this.db
      .insert(billingAddresses)
      .values({ userId })
      .onConflictDoNothing();

    const [created] = await this.db
      .select()
      .from(billingAddresses)
      .where(eq(billingAddresses.userId, userId))
      .limit(1);

    return created;
  }

  async upsertBillingAddress(
    userId: string,
    dto: UpdateBillingAddressDto,
  ): Promise<BillingAddress> {
    const now = new Date();

    const [address] = await this.db
      .insert(billingAddresses)
      .values({
        userId,
        line1: dto.line1,
        line2: dto.line2,
        city: dto.city,
        state: dto.state,
        postalCode: dto.postalCode,
        country: dto.country,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: billingAddresses.userId,
        set: {
          line1: dto.line1,
          line2: dto.line2,
          city: dto.city,
          state: dto.state,
          postalCode: dto.postalCode,
          country: dto.country,
          updatedAt: now,
        },
      })
      .returning();

    return address;
  }
}
