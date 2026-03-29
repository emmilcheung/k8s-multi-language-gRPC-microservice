import { IsString, IsInt, IsOptional, Min, IsUUID, IsIn, MaxLength } from 'class-validator';

// ISO 4217 currency codes accepted by the platform
const ALLOWED_CURRENCIES = [
  'usd',
  'eur',
  'gbp',
  'cad',
  'aud',
  'jpy',
  'chf',
  'sgd',
  'hkd',
  'nok',
  'sek',
  'dkk',
];

export class ChargeDto {
  @IsUUID('all')
  orderId!: string;

  @IsInt()
  @Min(1)
  amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(3)
  @IsIn(ALLOWED_CURRENCIES, {
    message: `currency must be one of: ${ALLOWED_CURRENCIES.join(', ')}`,
  })
  currency?: string;

  /** Stripe paymentMethodId obtained from the client-side Stripe.js. */
  @IsString()
  token!: string;
}
