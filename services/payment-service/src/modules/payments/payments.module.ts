import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import Stripe from 'stripe';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaymentsRepository } from './payments.repository';
import { STRIPE_CLIENT } from './stripe.constants';

@Module({
  imports: [PinoLoggerModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    PaymentsRepository,
    {
      provide: STRIPE_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Stripe => {
        const secretKey = config.getOrThrow<string>('STRIPE_SECRET_KEY');
        return new Stripe(secretKey, { apiVersion: '2025-02-24.acacia' });
      },
    },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
