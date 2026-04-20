import { Resolver, Query, ResolveReference, Args, Context } from '@nestjs/graphql';
import { NotFoundException } from '@nestjs/common';
import { PaymentsService } from '../modules/payments/payments.service';

interface GqlContext {
  req: {
    headers: Record<string, string | string[] | undefined>;
  };
}

@Resolver('Payment')
export class PaymentResolver {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Query()
  async payment(@Args('id') id: string, @Context() ctx: GqlContext) {
    try {
      const payment = await this.paymentsService.findById(id);
      if (payment.userId !== ctx.req.headers['x-user-id']) return null;
      return payment;
    } catch (e) {
      if (e instanceof NotFoundException) return null;
      throw e;
    }
  }

  @ResolveReference()
  async resolveReference(reference: { __typename: string; id: string }) {
    try {
      return await this.paymentsService.findById(reference.id);
    } catch (e) {
      if (e instanceof NotFoundException) return null;
      throw e;
    }
  }
}
