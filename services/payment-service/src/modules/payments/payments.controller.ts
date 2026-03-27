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
      amount: dto.amount,
      currency: dto.currency,
      token: dto.token,
    });

    return { payment };
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
