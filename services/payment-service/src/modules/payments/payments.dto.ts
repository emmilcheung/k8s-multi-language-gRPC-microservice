import { IsString, IsInt, IsOptional, Min, IsUUID } from 'class-validator';

export class ChargeDto {
  @IsUUID('all')
  orderId!: string;

  @IsInt()
  @Min(1)
  amount!: number;

  @IsString()
  @IsOptional()
  currency?: string;

  /** Stripe paymentMethodId obtained from the client-side Stripe.js. */
  @IsString()
  token!: string;
}
