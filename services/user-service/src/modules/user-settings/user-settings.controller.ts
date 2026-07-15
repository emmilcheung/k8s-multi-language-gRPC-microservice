import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Put,
  UseGuards,
} from "@nestjs/common";
import { UserIdSigRestGuard } from "../../common/security/user-id-sig-rest.guard";
import {
  UpdateBillingAddressDto,
  UpdatePreferencesDto,
  UpdateProfileDto,
} from "./user-settings.dto";
import { UserSettingsService } from "./user-settings.service";

@Controller("api/user-settings")
@UseGuards(UserIdSigRestGuard)
export class UserSettingsController {
  constructor(private readonly userSettingsService: UserSettingsService) {}

  @Get("profile")
  async getProfile(@Headers("x-user-id") userId: string | undefined) {
    const currentUserId = this.requireUserId(userId);
    const profile = await this.userSettingsService.getProfile(currentUserId);
    return { profile };
  }

  @Put("profile")
  @HttpCode(HttpStatus.OK)
  async updateProfile(
    @Headers("x-user-id") userId: string | undefined,
    @Body() dto: UpdateProfileDto,
  ) {
    const currentUserId = this.requireUserId(userId);
    const profile = await this.userSettingsService.updateProfile(
      currentUserId,
      dto,
    );
    return { profile };
  }

  @Get("preferences")
  async getPreferences(@Headers("x-user-id") userId: string | undefined) {
    const currentUserId = this.requireUserId(userId);
    const preferences =
      await this.userSettingsService.getPreferences(currentUserId);
    return { preferences };
  }

  @Put("preferences")
  @HttpCode(HttpStatus.OK)
  async updatePreferences(
    @Headers("x-user-id") userId: string | undefined,
    @Body() dto: UpdatePreferencesDto,
  ) {
    const currentUserId = this.requireUserId(userId);
    const preferences = await this.userSettingsService.updatePreferences(
      currentUserId,
      dto,
    );
    return { preferences };
  }

  @Get("billing-address")
  async getBillingAddress(@Headers("x-user-id") userId: string | undefined) {
    const currentUserId = this.requireUserId(userId);
    const billingAddress =
      await this.userSettingsService.getBillingAddress(currentUserId);
    return { billingAddress };
  }

  @Put("billing-address")
  @HttpCode(HttpStatus.OK)
  async updateBillingAddress(
    @Headers("x-user-id") userId: string | undefined,
    @Body() dto: UpdateBillingAddressDto,
  ) {
    const currentUserId = this.requireUserId(userId);
    const billingAddress = await this.userSettingsService.updateBillingAddress(
      currentUserId,
      dto,
    );
    return { billingAddress };
  }

  private requireUserId(userId: string | undefined): string {
    if (userId && userId.trim().length > 0) {
      return userId;
    }

    throw new BadRequestException({
      error: {
        code: "MISSING_USER_ID",
        message: "X-User-Id header is required",
      },
    });
  }
}
