import { Resolver, Query, Mutation, ResolveReference, Args, Context } from '@nestjs/graphql';
import { ForbiddenException, NotFoundException, UseGuards } from '@nestjs/common';
import { PaymentsService } from '../modules/payments/payments.service';
import type { SavedPaymentMethod } from '../database/schema';
import { UserIdSigGuard } from './guards/user-id-sig.guard';

interface GqlContext {
  req: {
    headers: Record<string, string | string[] | undefined>;
  };
}

interface RegisterPaymentMethodInput {
  providerPaymentMethodId: string;
  setAsDefault?: boolean;
  consentAccepted: boolean;
  consentVersion: string;
}

type PaymentReference = { __typename: string; id?: string; orderId?: string };

function requireUserId(ctx: GqlContext): string {
  const userId = ctx.req.headers['x-user-id'];
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new ForbiddenException('Missing X-User-Id');
  }
  return userId;
}

function getHeader(ctx: GqlContext, name: string): string | undefined {
  const raw = ctx.req.headers[name];
  if (Array.isArray(raw)) return raw[0];
  return typeof raw === 'string' ? raw : undefined;
}

function extractConsentSource(ctx: GqlContext): string {
  const value = getHeader(ctx, 'x-consent-source');
  if (!value) return 'unknown';
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 64) : 'unknown';
}

function extractUserAgent(ctx: GqlContext): string | undefined {
  const value = getHeader(ctx, 'user-agent');
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 512) : undefined;
}

function extractIp(ctx: GqlContext): string | undefined {
  const fwd = getHeader(ctx, 'x-forwarded-for');
  if (fwd) return fwd.split(',')[0]?.trim();
  return undefined;
}

function toPaymentMethodResponse(pm: SavedPaymentMethod) {
  return {
    id: pm.id,
    brand: pm.brand,
    last4: pm.last4,
    expMonth: pm.expMonth,
    expYear: pm.expYear,
    isDefault: pm.isDefault,
    label: `${pm.brand.toUpperCase()} •••• ${pm.last4}`,
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
      return payment;
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
      return payment;
    } catch (e) {
      if (e instanceof NotFoundException) return null;
      throw e;
    }
  }
}

@Resolver('PaymentMethod')
export class PaymentMethodResolver {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Query('paymentMethods')
  @UseGuards(UserIdSigGuard)
  async paymentMethods(@Context() ctx: GqlContext) {
    const userId = requireUserId(ctx);
    const methods = await this.paymentsService.listSavedPaymentMethods(userId);
    return methods.map(toPaymentMethodResponse);
  }

  @Mutation('registerPaymentMethod')
  @UseGuards(UserIdSigGuard)
  async registerPaymentMethod(
    @Args('input') input: RegisterPaymentMethodInput,
    @Context() ctx: GqlContext,
  ) {
    const userId = requireUserId(ctx);
    const method = await this.paymentsService.registerSavedPaymentMethod(
      userId,
      {
        providerPaymentMethodId: input.providerPaymentMethodId,
        setAsDefault: input.setAsDefault,
        consentAccepted: input.consentAccepted,
        consentVersion: input.consentVersion,
      },
      {
        source: extractConsentSource(ctx),
        userAgent: extractUserAgent(ctx),
        ipAddress: extractIp(ctx),
      },
    );
    return toPaymentMethodResponse(method);
  }

  @Mutation('setDefaultPaymentMethod')
  @UseGuards(UserIdSigGuard)
  async setDefaultPaymentMethod(@Args('id') id: string, @Context() ctx: GqlContext) {
    const userId = requireUserId(ctx);
    const method = await this.paymentsService.setDefaultSavedPaymentMethod(userId, id);
    return toPaymentMethodResponse(method);
  }

  @Mutation('deletePaymentMethod')
  @UseGuards(UserIdSigGuard)
  async deletePaymentMethod(@Args('id') id: string, @Context() ctx: GqlContext): Promise<boolean> {
    const userId = requireUserId(ctx);
    await this.paymentsService.deleteSavedPaymentMethod(userId, id);
    return true;
  }
}
