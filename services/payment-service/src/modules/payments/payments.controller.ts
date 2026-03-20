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
  async charge(
    @Headers('x-user-id') userId: string | undefined,
    @Body() dto: ChargeDto,
  ) {
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
   */
  @Get(':id')
  async findOne(@Param('id') id: string) {
    const payment = await this.paymentsService.findById(id);
    return { payment };
  }
}
