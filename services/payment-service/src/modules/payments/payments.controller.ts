import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
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
import {
  ChargeDto,
  RegisterSavedPaymentMethodDto,
  SavedPaymentMethodResponseDto,
  SetDefaultSavedPaymentMethodDto,
} from './payments.dto';
import { type SavedPaymentMethod } from '../../database/schema';
import type { Request } from 'express';

@Controller('api/payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  private toSavedPaymentMethodResponse(
    paymentMethod: SavedPaymentMethod,
  ): SavedPaymentMethodResponseDto {
    const brand = paymentMethod.brand;
    const last4 = paymentMethod.last4;

    return {
      id: paymentMethod.id,
      brand,
      last4,
      expMonth: paymentMethod.expMonth,
      expYear: paymentMethod.expYear,
      isDefault: paymentMethod.isDefault,
      label: `${brand.toUpperCase()} •••• ${last4}`,
    };
  }

  private extractUserAgent(req: Request): string | undefined {
    const value = req.headers['user-agent'];
    if (typeof value !== 'string') {
      return undefined;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized.slice(0, 512) : undefined;
  }

  private extractClientIp(req: Request): string | undefined {
    const forwardedFor = req.headers['x-forwarded-for'];
    if (Array.isArray(forwardedFor)) {
      const first = forwardedFor.find((entry) => typeof entry === 'string' && entry.trim().length);
      return first?.split(',')[0]?.trim();
    }

    if (typeof forwardedFor === 'string') {
      return forwardedFor.split(',')[0]?.trim();
    }

    return req.ip;
  }

  private extractConsentSource(req: Request): string {
    const header = req.headers['x-consent-source'];
    if (typeof header !== 'string') {
      return 'unknown';
    }

    const normalized = header.trim();
    return normalized.length > 0 ? normalized.slice(0, 64) : 'unknown';
  }

  private requireUserId(userId: string | undefined): string {
    if (!userId) {
      throw new BadRequestException({
        error: { code: 'MISSING_USER_ID', message: 'X-User-Id header is required' },
      });
    }
    return userId;
  }

  /**
   * POST /api/payments
   * Charge a payment for an order.
   * Requires X-User-Id header injected by Kong after JWT validation.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async charge(@Headers('x-user-id') userId: string | undefined, @Body() dto: ChargeDto) {
    const ownerUserId = this.requireUserId(userId);

    const payment = await this.paymentsService.charge({
      orderId: dto.orderId,
      userId: ownerUserId,
      token: dto.token,
      savedPaymentMethodId: dto.savedPaymentMethodId,
    });

    return { payment };
  }

  @Post('methods/register')
  @HttpCode(HttpStatus.CREATED)
  async registerSavedPaymentMethod(
    @Headers('x-user-id') userId: string | undefined,
    @Body() dto: RegisterSavedPaymentMethodDto,
    @Req() req: Request,
  ) {
    const ownerUserId = this.requireUserId(userId);
    const paymentMethod = await this.paymentsService.registerSavedPaymentMethod(ownerUserId, dto, {
      source: this.extractConsentSource(req),
      userAgent: this.extractUserAgent(req),
      ipAddress: this.extractClientIp(req),
    });
    return { paymentMethod: this.toSavedPaymentMethodResponse(paymentMethod) };
  }

  @Get('methods')
  async listSavedPaymentMethods(@Headers('x-user-id') userId: string | undefined) {
    const ownerUserId = this.requireUserId(userId);
    const paymentMethods = await this.paymentsService.listSavedPaymentMethods(ownerUserId);
    return {
      paymentMethods: paymentMethods.map((paymentMethod) =>
        this.toSavedPaymentMethodResponse(paymentMethod),
      ),
    };
  }

  @Patch('methods/:id/default')
  async setDefaultSavedPaymentMethod(
    @Headers('x-user-id') userId: string | undefined,
    @Param() params: SetDefaultSavedPaymentMethodDto,
  ) {
    const ownerUserId = this.requireUserId(userId);
    const paymentMethod = await this.paymentsService.setDefaultSavedPaymentMethod(
      ownerUserId,
      params.id,
    );
    return { paymentMethod: this.toSavedPaymentMethodResponse(paymentMethod) };
  }

  @Delete('methods/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteSavedPaymentMethod(
    @Headers('x-user-id') userId: string | undefined,
    @Param() params: SetDefaultSavedPaymentMethodDto,
  ): Promise<void> {
    const ownerUserId = this.requireUserId(userId);
    await this.paymentsService.deleteSavedPaymentMethod(ownerUserId, params.id);
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
