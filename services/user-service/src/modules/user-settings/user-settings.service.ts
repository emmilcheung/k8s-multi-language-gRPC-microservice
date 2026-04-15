import { Injectable } from "@nestjs/common";
import {
  type BillingAddress,
  type UserPreferences,
  type UserProfile,
} from "../../database/schema";
import {
  type UpdateBillingAddressDto,
  type UpdatePreferencesDto,
  type UpdateProfileDto,
} from "./user-settings.dto";
import { UserSettingsRepository } from "./user-settings.repository";

@Injectable()
export class UserSettingsService {
  constructor(private readonly repository: UserSettingsRepository) {}

  getProfile(userId: string): Promise<UserProfile> {
    return this.repository.getOrCreateProfile(userId);
  }

  updateProfile(userId: string, dto: UpdateProfileDto): Promise<UserProfile> {
    return this.repository.upsertProfile(userId, dto);
  }

  getPreferences(userId: string): Promise<UserPreferences> {
    return this.repository.getOrCreatePreferences(userId);
  }

  updatePreferences(
    userId: string,
    dto: UpdatePreferencesDto,
  ): Promise<UserPreferences> {
    return this.repository.upsertPreferences(userId, dto);
  }

  getBillingAddress(userId: string): Promise<BillingAddress> {
    return this.repository.getOrCreateBillingAddress(userId);
  }

  updateBillingAddress(
    userId: string,
    dto: UpdateBillingAddressDto,
  ): Promise<BillingAddress> {
    return this.repository.upsertBillingAddress(userId, dto);
  }
}
