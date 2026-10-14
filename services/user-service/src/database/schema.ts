import {
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { Roles } from "../modules/accounts/roles";

export const userProfiles = pgTable("user_profiles", {
  userId: text("user_id").primaryKey(),
  displayName: text("display_name"),
  locale: text("locale"),
  timezone: text("timezone"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const userPreferences = pgTable("user_preferences", {
  userId: text("user_id").primaryKey(),
  marketingOptIn: boolean("marketing_opt_in").notNull().default(false),
  orderUpdates: boolean("order_updates").notNull().default(true),
  productUpdates: boolean("product_updates").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const billingAddresses = pgTable("billing_addresses", {
  userId: text("user_id").primaryKey(),
  line1: text("line1"),
  line2: text("line2"),
  city: text("city"),
  state: text("state"),
  postalCode: text("postal_code"),
  country: text("country"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const organizerAccounts = pgTable(
  "organizer_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    contactEmail: text("contact_email"),
    status: text("status")
      .$type<"ACTIVE" | "SUSPENDED">()
      .notNull()
      .default("ACTIVE"),
    personalForUserId: text("personal_for_user_id"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("organizer_accounts_personal_for_user_id_key")
      .on(t.personalForUserId)
      .where(sql`${t.personalForUserId} IS NOT NULL`),
  ],
);

export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    resourceType: text("resource_type")
      .$type<"ORGANIZER_ACCOUNT" | "VENUE">()
      .notNull(),
    resourceId: text("resource_id").notNull(),
    role: text("role").$type<Roles>().notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("memberships_user_resource_key").on(
      t.userId,
      t.resourceType,
      t.resourceId,
    ),
    index("memberships_resource_idx").on(t.resourceType, t.resourceId),
  ],
);

export const membershipEventScopes = pgTable(
  "membership_event_scopes",
  {
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.membershipId, t.eventId] })],
);

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => organizerAccounts.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '7 days'`),
    acceptedBy: text("accepted_by"),
    status: text("status")
      .$type<"PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED">()
      .notNull()
      .default("PENDING"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("invitations_account_idx").on(t.accountId)],
);

export const venueClaims = pgTable(
  "venue_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    venueId: text("venue_id").notNull(),
    claimantUserId: text("claimant_user_id").notNull(),
    claimantAccountId: uuid("claimant_account_id").references(
      () => organizerAccounts.id,
    ),
    evidenceText: text("evidence_text"),
    status: text("status")
      .$type<"PENDING" | "APPROVED" | "REJECTED">()
      .notNull()
      .default("PENDING"),
    decidedBy: text("decided_by"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("venue_claims_venue_idx").on(t.venueId)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actorUserId: text("actor_user_id").notNull(),
    actorAccountId: text("actor_account_id"),
    action: text("action").notNull(),
    resource: text("resource").notNull(),
    before: jsonb("before").$type<Record<string, unknown>>(),
    after: jsonb("after").$type<Record<string, unknown>>(),
    reason: text("reason"),
    traceId: text("trace_id"),
  },
  (t) => [index("audit_log_resource_at_idx").on(t.resource, t.at.desc())],
);

export type OrganizerAccount = typeof organizerAccounts.$inferSelect;
export type Invitation = typeof invitations.$inferSelect;
export type VenueClaim = typeof venueClaims.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type UserProfile = typeof userProfiles.$inferSelect;
export type UserPreferences = typeof userPreferences.$inferSelect;
export type BillingAddress = typeof billingAddresses.$inferSelect;
