import { Injectable, Inject } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDB } from '../../database/database.module';
import { payments, type Payment, type NewPayment, type PaymentStatus } from '../../database/schema';

@Injectable()
export class PaymentsRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDB) {}

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
}
