import { IsString, IsUUID } from 'class-validator';

export class ChargeDto {
  @IsUUID('all')
  orderId!: string;

  /** Stripe paymentMethodId obtained from the client-side Stripe.js. */
  @IsString()
  token!: string;
}
