import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class ChargeDto {
  @IsUUID('all')
  orderId!: string;

  /** Stripe paymentMethodId obtained from the client-side Stripe.js. */
  @ValidateIf((dto: ChargeDto) => !dto.savedPaymentMethodId)
  @IsString()
  token?: string;

  @ValidateIf((dto: ChargeDto) => !dto.token)
  @IsUUID('all')
  savedPaymentMethodId?: string;
}

export class RegisterSavedPaymentMethodDto {
  @IsString()
  providerPaymentMethodId!: string;

  @IsOptional()
  @IsBoolean()
  setAsDefault?: boolean;

  @IsBoolean()
  consentAccepted!: boolean;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  consentVersion!: string;
}

export class SetDefaultSavedPaymentMethodDto {
  @IsUUID('all')
  id!: string;
}

export interface SavedPaymentMethodResponseDto {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
  label: string;
}
