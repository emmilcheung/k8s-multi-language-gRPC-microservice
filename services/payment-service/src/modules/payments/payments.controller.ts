import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  Headers,
  BadRequestException,
  UnauthorizedException,
  NotFoundException,
  ForbiddenException,
  Req,
} from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { ChargeDto } from './payments.dto';

@Controller('api/payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  /**
   * POST /api/payments
   * Charge a payment for an order.
   * Requires X-User-Id header injected by Kong after JWT validation.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async charge(@Headers('x-user-id') userId: string | undefined, @Body() dto: ChargeDto) {
    if (!userId) {
      throw new BadRequestException({
        error: { code: 'MISSING_USER_ID', message: 'X-User-Id header is required' },
      });
    }

    const payment = await this.paymentsService.charge({
      orderId: dto.orderId,
      userId,
      token: dto.token,
    });

    return { payment };
  }

  /**
   * POST /api/payments/webhook
   * Stripe webhook endpoint — receives payment lifecycle events and drives order completion.
   * This route must be UNAUTHENTICATED in Kong (Stripe cannot present a JWT).
   * Kong route: payments-webhook (no jwt plugin, POST /api/payments/webhook only).
   *
   * Stripe signature verification is performed inside PaymentsService using the raw
   * request body (enabled via NestFactory rawBody: true in main.ts).
   */
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async stripeWebhook(
    @Req() req: { rawBody?: Buffer; body?: unknown },
    @Headers('stripe-signature') sig: string | undefined,
  ): Promise<{ received: boolean }> {
    if (!sig) {
      throw new BadRequestException({
        error: { code: 'MISSING_SIGNATURE', message: 'stripe-signature header is required' },
      });
    }
    const rawBody: Buffer = req.rawBody ?? Buffer.from(JSON.stringify(req.body));
    const event = this.paymentsService.constructWebhookEvent(rawBody, sig);
    await this.paymentsService.handleStripeEvent(event);
    return { received: true };
  }

  /**
   * GET /api/payments/:id
   * Retrieve a payment by its ID.
   * Requires X-User-Id header; returns 403 if the requesting user does not own the payment.
   */
  @Get(':id')
  async findOne(@Param('id') id: string, @Headers('x-user-id') userId: string | undefined) {
    if (!userId) {
      throw new UnauthorizedException({
        error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
      });
    }

    const payment = await this.paymentsService.findById(id);

    if (!payment) {
      throw new NotFoundException({
        error: { code: 'PAYMENT_NOT_FOUND', message: `Payment ${id} not found` },
      });
    }

    if (payment.userId !== userId) {
      throw new ForbiddenException({
        error: { code: 'FORBIDDEN', message: 'You do not have access to this payment' },
      });
    }

    return { payment };
  }
}
