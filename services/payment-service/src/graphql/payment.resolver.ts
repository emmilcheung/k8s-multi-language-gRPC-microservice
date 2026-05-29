import {
  Resolver,
  Query,
  ResolveReference,
  Args,
  Context,
  Mutation,
  ResolveField,
  Parent,
} from '@nestjs/graphql';
import { NotFoundException, UseGuards, ForbiddenException } from '@nestjs/common';
import { PaymentsService } from '../modules/payments/payments.service';
import type { Payment, SavedPaymentMethod } from '../database/schema';
import { UserIdSigGuard } from './guards/user-id-sig.guard';

const DB_STATUS_TO_GRAPHQL: Record<string, 'PENDING' | 'CAPTURED' | 'FAILED' | 'REFUNDED'> = {
  pending: 'PENDING',
  completed: 'CAPTURED',
  failed: 'FAILED',
  refunded: 'REFUNDED',
};

function toPaymentResponse(payment: Payment) {
  const status = DB_STATUS_TO_GRAPHQL[payment.status];
  if (!status) {
    throw new Error(`Unmapped payment status: ${payment.status}`);
  }
  return { ...payment, status };
}

interface GqlContext {
  req: {
    headers: Record<string, string | string[] | undefined>;
  };
}

type PaymentReference = { __typename: string; id?: string; orderId?: string };
type UserReference = { __typename: string; id: string };

function extractUserId(ctx: GqlContext): string | null {
  const userId = ctx.req.headers['x-user-id'];
  if (typeof userId === 'string' && userId.length > 0) {
    return userId;
  }
  return null;
}

function extractUserIdSig(ctx: GqlContext): string | undefined {
  const signature = ctx.req.headers['x-user-id-sig'];
  if (typeof signature === 'string' && signature.length > 0) {
    return signature;
  }
  return undefined;
}

function extractConsentSource(ctx: GqlContext): string {
  const header = ctx.req.headers['x-consent-source'];
  if (typeof header !== 'string') {
    return 'unknown';
  }
  const normalized = header.trim();
  return normalized.length > 0 ? normalized.slice(0, 64) : 'unknown';
}

function extractUserAgent(ctx: GqlContext): string | undefined {
  const value = ctx.req.headers['user-agent'];
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized.slice(0, 512) : undefined;
}

function extractClientIp(ctx: GqlContext): string | undefined {
  const forwardedFor = ctx.req.headers['x-forwarded-for'];
  if (Array.isArray(forwardedFor)) {
    const first = forwardedFor.find((entry) => typeof entry === 'string' && entry.trim().length);
    return first?.split(',')[0]?.trim();
  }
  if (typeof forwardedFor === 'string') {
    return forwardedFor.split(',')[0]?.trim();
  }
  return undefined;
}

function toPaymentMethodResponse(savedPaymentMethod: SavedPaymentMethod) {
  const brand = savedPaymentMethod.brand;
  const last4 = savedPaymentMethod.last4;
  return {
    id: savedPaymentMethod.id,
    brand,
    last4,
    expMonth: savedPaymentMethod.expMonth,
    expYear: savedPaymentMethod.expYear,
    isDefault: savedPaymentMethod.isDefault,
    label: `${brand.toUpperCase()} •••• ${last4}`,
  };
}

@Resolver('Payment')
export class PaymentResolver {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Query()
  @UseGuards(UserIdSigGuard)
  async payment(@Args('id') id: string, @Context() ctx: GqlContext) {
    try {
      const payment = await this.paymentsService.findById(id);
      if (payment.userId !== ctx.req.headers['x-user-id']) return null;
      return toPaymentResponse(payment);
    } catch (e) {
      if (e instanceof NotFoundException) return null;
      throw e;
    }
  }

  @ResolveReference()
  @UseGuards(UserIdSigGuard)
  async resolveReference(reference: PaymentReference, @Context() ctx: GqlContext) {
    try {
      const payment = reference.id
        ? await this.paymentsService.findById(reference.id)
        : reference.orderId
          ? await this.paymentsService.findByOrderId(reference.orderId)
          : null;
      const requesterId = ctx.req.headers['x-user-id'] as string;
      if (!payment || !requesterId || payment.userId !== requesterId) return null;
      return toPaymentResponse(payment);
    } catch (e) {
      if (e instanceof NotFoundException) return null;
      throw e;
    }
  }
}

@Resolver('User')
export class UserPaymentMethodResolver {
  constructor(private readonly paymentsService: PaymentsService) {}

  @ResolveField()
  @UseGuards(UserIdSigGuard)
  async paymentMethods(@Parent() user: UserReference, @Context() ctx: GqlContext) {
    const requesterId = extractUserId(ctx);
    if (!requesterId || requesterId !== user.id) {
      return [];
    }
    const methods = await this.paymentsService.listSavedPaymentMethods(user.id);
    return methods.map(toPaymentMethodResponse);
  }
}

@Resolver()
export class PaymentMethodMutationResolver {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Mutation('createPayment')
  @UseGuards(UserIdSigGuard)
  async createPayment(@Args('input') input: Record<string, unknown>, @Context() ctx: GqlContext) {
    const userId = extractUserId(ctx);
    if (!userId) {
      throw new ForbiddenException('Missing X-User-Id');
    }
    const payment = await this.paymentsService.charge({
      orderId: input.orderId as string,
      userId,
      token: input.token as string | undefined,
      savedPaymentMethodId: input.savedPaymentMethodId as string | undefined,
      userIdSig: extractUserIdSig(ctx),
    });
    return toPaymentResponse(payment);
  }

  @Mutation('requestRefund')
  @UseGuards(UserIdSigGuard)
  async requestRefund(@Args('input') input: Record<string, unknown>, @Context() ctx: GqlContext) {
    const userId = extractUserId(ctx);
    if (!userId) {
      throw new ForbiddenException('Missing X-User-Id');
    }
    const result = await this.paymentsService.requestRefund({
      orderId: input.orderId as string,
      reason: input.reason as string,
      userId,
      userIdSig: extractUserIdSig(ctx),
    });

    return {
      payment: toPaymentResponse(result.payment),
      refundId: result.refundId,
      status: result.status,
    };
  }

  @Mutation('setDefaultPaymentMethod')
  @UseGuards(UserIdSigGuard)
  async setDefaultPaymentMethod(@Args('id') id: string, @Context() ctx: GqlContext) {
    const userId = extractUserId(ctx);
    if (!userId) {
      throw new ForbiddenException('Missing X-User-Id');
    }
    const method = await this.paymentsService.setDefaultSavedPaymentMethod(userId, id);
    return toPaymentMethodResponse(method);
  }

  @Mutation('deletePaymentMethod')
  @UseGuards(UserIdSigGuard)
  async deletePaymentMethod(@Args('id') id: string, @Context() ctx: GqlContext) {
    const userId = extractUserId(ctx);
    if (!userId) {
      throw new ForbiddenException('Missing X-User-Id');
    }
    await this.paymentsService.deleteSavedPaymentMethod(userId, id);
    return true;
  }

  @Mutation('registerPaymentMethod')
  @UseGuards(UserIdSigGuard)
  async registerPaymentMethod(
    @Args('input') input: Record<string, unknown>,
    @Context() ctx: GqlContext,
  ) {
    const userId = extractUserId(ctx);
    if (!userId) {
      throw new ForbiddenException('Missing X-User-Id');
    }
    const dto = {
      providerPaymentMethodId: input.providerPaymentMethodId as string,
      setAsDefault: (input.setAsDefault as boolean | undefined) ?? false,
      consentAccepted: input.consentAccepted as boolean,
      consentVersion: input.consentVersion as string,
    };
    const method = await this.paymentsService.registerSavedPaymentMethod(userId, dto, {
      source: extractConsentSource(ctx),
      userAgent: extractUserAgent(ctx),
      ipAddress: extractClientIp(ctx),
    });
    return toPaymentMethodResponse(method);
  }
}
