import { Injectable, Inject } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDB } from '../../database/database.module';
import {
  paymentCustomers,
  payments,
  refunds,
  savedPaymentMethods,
  type NewPayment,
  type NewPaymentCustomer,
  type NewRefund,
  type NewSavedPaymentMethod,
  type Payment,
  type PaymentCustomer,
  type PaymentStatus,
  type Refund,
  type SavedPaymentMethod,
} from '../../database/schema';

@Injectable()
export class PaymentsRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDB) {}

  async findPaymentCustomerByUserId(userId: string): Promise<PaymentCustomer | null> {
    const [row] = await this.db
      .select()
      .from(paymentCustomers)
      .where(eq(paymentCustomers.userId, userId));
    return row ?? null;
  }

  async createPaymentCustomer(data: NewPaymentCustomer): Promise<PaymentCustomer> {
    const [row] = await this.db.insert(paymentCustomers).values(data).returning();
    return row;
  }

  async create(data: NewPayment): Promise<Payment> {
    const [row] = await this.db.insert(payments).values(data).returning();
    return row;
  }

  async findById(id: string): Promise<Payment | null> {
    const [row] = await this.db.select().from(payments).where(eq(payments.id, id));
    return row ?? null;
  }

  async findByOrderId(orderId: string): Promise<Payment | null> {
    const [row] = await this.db.select().from(payments).where(eq(payments.orderId, orderId));
    return row ?? null;
  }

  async findSavedPaymentMethodById(id: string): Promise<SavedPaymentMethod | null> {
    const [row] = await this.db
      .select()
      .from(savedPaymentMethods)
      .where(eq(savedPaymentMethods.id, id));
    return row ?? null;
  }

  async findSavedPaymentMethodByProviderId(
    providerPaymentMethodId: string,
  ): Promise<SavedPaymentMethod | null> {
    const [row] = await this.db
      .select()
      .from(savedPaymentMethods)
      .where(eq(savedPaymentMethods.providerPaymentMethodId, providerPaymentMethodId));
    return row ?? null;
  }

  async listSavedPaymentMethodsByUserId(userId: string): Promise<SavedPaymentMethod[]> {
    return this.db
      .select()
      .from(savedPaymentMethods)
      .where(and(eq(savedPaymentMethods.userId, userId), isNull(savedPaymentMethods.deletedAt)))
      .orderBy(desc(savedPaymentMethods.createdAt));
  }

  async createSavedPaymentMethod(data: NewSavedPaymentMethod): Promise<SavedPaymentMethod> {
    const [row] = await this.db.insert(savedPaymentMethods).values(data).returning();
    return row;
  }

  async setDefaultSavedPaymentMethod(
    userId: string,
    id: string,
  ): Promise<SavedPaymentMethod | null> {
    const now = new Date();

    return this.db.transaction(async (tx) => {
      await tx
        .update(savedPaymentMethods)
        .set({ isDefault: false, updatedAt: now })
        .where(and(eq(savedPaymentMethods.userId, userId), isNull(savedPaymentMethods.deletedAt)));

      const [row] = await tx
        .update(savedPaymentMethods)
        .set({ isDefault: true, updatedAt: now })
        .where(
          and(
            eq(savedPaymentMethods.userId, userId),
            eq(savedPaymentMethods.id, id),
            isNull(savedPaymentMethods.deletedAt),
          ),
        )
        .returning();

      return row ?? null;
    });
  }

  async softDeleteSavedPaymentMethod(
    userId: string,
    id: string,
  ): Promise<SavedPaymentMethod | null> {
    const [row] = await this.db
      .update(savedPaymentMethods)
      .set({
        isDefault: false,
        deletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(savedPaymentMethods.userId, userId),
          eq(savedPaymentMethods.id, id),
          isNull(savedPaymentMethods.deletedAt),
        ),
      )
      .returning();

    return row ?? null;
  }

  async updateStatus(
    id: string,
    status: PaymentStatus,
    stripePaymentIntentId?: string,
  ): Promise<Payment> {
    const [row] = await this.db
      .update(payments)
      .set({
        status,
        ...(stripePaymentIntentId ? { stripePaymentIntentId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(payments.id, id))
      .returning();
    return row;
  }

  async createRefund(data: NewRefund): Promise<Refund> {
    const [row] = await this.db.insert(refunds).values(data).returning();
    return row;
  }

  async findActiveRefundByOrderId(orderId: string): Promise<Refund | null> {
    const [row] = await this.db
      .select()
      .from(refunds)
      .where(and(eq(refunds.orderId, orderId), eq(refunds.status, 'requested')))
      .orderBy(desc(refunds.createdAt));
    return row ?? null;
  }
}
