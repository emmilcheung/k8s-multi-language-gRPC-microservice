import type { TypedDocumentNode as DocumentNode } from '@graphql-typed-document-node/core';
export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
export type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]?: Maybe<T[SubKey]> };
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]: Maybe<T[SubKey]> };
export type MakeEmpty<T extends { [key: string]: unknown }, K extends keyof T> = { [_ in K]?: never };
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string; }
  String: { input: string; output: string; }
  Boolean: { input: boolean; output: boolean; }
  Int: { input: number; output: number; }
  Float: { input: number; output: number; }
  join__DirectiveArguments: { input: any; output: any; }
  join__FieldSet: { input: any; output: any; }
  join__FieldValue: { input: any; output: any; }
  link__Import: { input: any; output: any; }
};

export type AdmissionPass = {
  __typename?: 'AdmissionPass';
  eventId: Scalars['ID']['output'];
  id: Scalars['ID']['output'];
  issuedAt: Scalars['String']['output'];
  orderId: Scalars['ID']['output'];
  qrToken: Maybe<Scalars['String']['output']>;
  status: CredentialStatus;
  ticketId: Scalars['ID']['output'];
  usedAt: Maybe<Scalars['String']['output']>;
};

export type AssignmentMode =
  | 'AUTO'
  | 'MANUAL';

export type AttendancePolicy = {
  __typename?: 'AttendancePolicy';
  allowManualOverride: Scalars['Boolean']['output'];
  eventId: Scalars['ID']['output'];
  requireQrForEntry: Scalars['Boolean']['output'];
};

export type AttendanceSummary = {
  __typename?: 'AttendanceSummary';
  eventId: Scalars['ID']['output'];
  totalAdmitted: Scalars['Int']['output'];
  totalCheckedIn: Scalars['Int']['output'];
  totalDenied: Scalars['Int']['output'];
};

export type AttendeeInput = {
  name: Scalars['String']['input'];
  seatId: Scalars['ID']['input'];
};

export type BillingAddress = {
  __typename?: 'BillingAddress';
  city: Maybe<Scalars['String']['output']>;
  country: Maybe<Scalars['String']['output']>;
  line1: Maybe<Scalars['String']['output']>;
  line2: Maybe<Scalars['String']['output']>;
  postalCode: Maybe<Scalars['String']['output']>;
  state: Maybe<Scalars['String']['output']>;
};

export type BillingAddressInput = {
  city: Scalars['String']['input'];
  country: Scalars['String']['input'];
  line1: Scalars['String']['input'];
  line2?: InputMaybe<Scalars['String']['input']>;
  postalCode: Scalars['String']['input'];
  state?: InputMaybe<Scalars['String']['input']>;
};

export type CheckinSource =
  | 'MANUAL_OVERRIDE'
  | 'QR_SCAN'
  | 'USER_ID_LOOKUP';

export type CreateOrderInput = {
  quantity: Scalars['Int']['input'];
  ticketId: Scalars['ID']['input'];
};

export type CreatePaymentInput = {
  orderId: Scalars['ID']['input'];
  savedPaymentMethodId?: InputMaybe<Scalars['ID']['input']>;
  token?: InputMaybe<Scalars['String']['input']>;
};

export type CreatePriceTierInput = {
  name: Scalars['String']['input'];
  price: Scalars['String']['input'];
};

export type CreateSeatedOrderInput = {
  attendees?: InputMaybe<Array<AttendeeInput>>;
  planId: Scalars['ID']['input'];
  quantity: Scalars['Int']['input'];
  seatIds?: InputMaybe<Array<Scalars['ID']['input']>>;
  sectionId?: InputMaybe<Scalars['ID']['input']>;
  ticketId: Scalars['ID']['input'];
};

export type CreateSeatingPlanInput = {
  assignmentMode: AssignmentMode;
  maxSeatsPerOrder?: InputMaybe<Scalars['Int']['input']>;
  name: Scalars['String']['input'];
  pricingMode?: InputMaybe<Scalars['String']['input']>;
  ticketId: Scalars['ID']['input'];
  venueId: Scalars['ID']['input'];
};

export type CreateSectionInput = {
  columnCount: Scalars['Int']['input'];
  displayOrder?: InputMaybe<Scalars['Int']['input']>;
  name: Scalars['String']['input'];
  rowCount?: InputMaybe<Scalars['Int']['input']>;
  type: SectionType;
};

export type CreateTicketInput = {
  event: TicketEventInput;
  maxPerUser?: InputMaybe<Scalars['Int']['input']>;
  price: Scalars['Int']['input'];
  quota: Scalars['Int']['input'];
  ticketType: TicketType;
  title: Scalars['String']['input'];
};

export type CreateVenueInput = {
  address?: InputMaybe<Scalars['String']['input']>;
  capacity: Scalars['Int']['input'];
  name: Scalars['String']['input'];
  timezone: Scalars['String']['input'];
};

export type CredentialStatus =
  | 'EXPIRED'
  | 'ISSUED'
  | 'REVOKED'
  | 'USED';

export type EventCheckin = {
  __typename?: 'EventCheckin';
  checkedInAt: Scalars['String']['output'];
  eventId: Scalars['ID']['output'];
  id: Scalars['ID']['output'];
  orderId: Scalars['ID']['output'];
  source: CheckinSource;
  ticketId: Scalars['ID']['output'];
  userId: Maybe<Scalars['ID']['output']>;
};

export type Mutation = {
  __typename?: 'Mutation';
  activateSeatingPlan: SeatingPlan;
  cancelOrder: Order;
  createOrder: Order;
  createPayment: Payment;
  createPriceTier: PriceTier;
  createSeatedOrder: Order;
  createSeatingPlan: SeatingPlan;
  createSection: VenueSection;
  createTicket: Ticket;
  createVenue: Venue;
  deactivateSeatingPlan: SeatingPlan;
  deletePaymentMethod: Scalars['Boolean']['output'];
  holdSeats: SeatHoldResult;
  recordCheckin: EventCheckin;
  recordCheckinByUserId: EventCheckin;
  registerPaymentMethod: PaymentMethod;
  releaseSeats: Scalars['Boolean']['output'];
  revokeSession: Scalars['Boolean']['output'];
  saveEvent: Ticket;
  setDefaultPaymentMethod: PaymentMethod;
  unsaveEvent: Ticket;
  updateAttendancePolicy: AttendancePolicy;
  updateBillingAddress: BillingAddress;
  updatePreferences: UserPreferences;
  updateProfile: UserProfile;
  updateSeatingPlan: SeatingPlan;
  updateSection: VenueSection;
  updateTicket: Ticket;
  updateVenue: Venue;
  validateScan: ScanValidationResult;
};


export type MutationActivateSeatingPlanArgs = {
  id: Scalars['ID']['input'];
};


export type MutationCancelOrderArgs = {
  id: Scalars['ID']['input'];
};


export type MutationCreateOrderArgs = {
  input: CreateOrderInput;
};


export type MutationCreatePaymentArgs = {
  input: CreatePaymentInput;
};


export type MutationCreatePriceTierArgs = {
  input: CreatePriceTierInput;
  planId: Scalars['ID']['input'];
};


export type MutationCreateSeatedOrderArgs = {
  input: CreateSeatedOrderInput;
};


export type MutationCreateSeatingPlanArgs = {
  input: CreateSeatingPlanInput;
};


export type MutationCreateSectionArgs = {
  input: CreateSectionInput;
  venueId: Scalars['ID']['input'];
};


export type MutationCreateTicketArgs = {
  input: CreateTicketInput;
};


export type MutationCreateVenueArgs = {
  input: CreateVenueInput;
};


export type MutationDeactivateSeatingPlanArgs = {
  id: Scalars['ID']['input'];
};


export type MutationDeletePaymentMethodArgs = {
  id: Scalars['ID']['input'];
};


export type MutationHoldSeatsArgs = {
  planId: Scalars['ID']['input'];
  seatIds: Array<Scalars['ID']['input']>;
};


export type MutationRecordCheckinArgs = {
  input: RecordCheckinInput;
};


export type MutationRecordCheckinByUserIdArgs = {
  input: RecordCheckinByUserIdInput;
};


export type MutationRegisterPaymentMethodArgs = {
  input: RegisterPaymentMethodInput;
};


export type MutationReleaseSeatsArgs = {
  planId: Scalars['ID']['input'];
  seatIds: Array<Scalars['ID']['input']>;
};


export type MutationRevokeSessionArgs = {
  id: Scalars['ID']['input'];
};


export type MutationSaveEventArgs = {
  eventId: Scalars['ID']['input'];
};


export type MutationSetDefaultPaymentMethodArgs = {
  id: Scalars['ID']['input'];
};


export type MutationUnsaveEventArgs = {
  eventId: Scalars['ID']['input'];
};


export type MutationUpdateAttendancePolicyArgs = {
  eventId: Scalars['ID']['input'];
  input: UpdateAttendancePolicyInput;
};


export type MutationUpdateBillingAddressArgs = {
  input: BillingAddressInput;
};


export type MutationUpdatePreferencesArgs = {
  input: UpdatePreferencesInput;
};


export type MutationUpdateProfileArgs = {
  input: UpdateProfileInput;
};


export type MutationUpdateSeatingPlanArgs = {
  id: Scalars['ID']['input'];
  input: UpdateSeatingPlanInput;
};


export type MutationUpdateSectionArgs = {
  id: Scalars['ID']['input'];
  input: UpdateSectionInput;
};


export type MutationUpdateTicketArgs = {
  id: Scalars['ID']['input'];
  input: UpdateTicketInput;
};


export type MutationUpdateVenueArgs = {
  id: Scalars['ID']['input'];
  input: UpdateVenueInput;
};


export type MutationValidateScanArgs = {
  token: Scalars['String']['input'];
};

export type Order = {
  __typename?: 'Order';
  createdAt: Scalars['String']['output'];
  expiresAt: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  payment: Maybe<Payment>;
  quantity: Scalars['Int']['output'];
  status: OrderStatus;
  ticket: OrderTicket;
  userId: Scalars['ID']['output'];
};

export type OrderStatus =
  | 'AWAITING_PAYMENT'
  | 'CANCELLED'
  | 'COMPLETE'
  | 'CREATED';

export type OrderTicket = {
  __typename?: 'OrderTicket';
  id: Scalars['ID']['output'];
  price: Scalars['String']['output'];
  title: Scalars['String']['output'];
};

export type PageInfo = {
  __typename?: 'PageInfo';
  endCursor: Maybe<Scalars['String']['output']>;
  hasNextPage: Scalars['Boolean']['output'];
};

export type Payment = {
  __typename?: 'Payment';
  amount: Scalars['Int']['output'];
  createdAt: Scalars['String']['output'];
  currency: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  orderId: Scalars['ID']['output'];
  status: PaymentStatus;
};

export type PaymentMethod = {
  __typename?: 'PaymentMethod';
  brand: Maybe<Scalars['String']['output']>;
  expMonth: Maybe<Scalars['Int']['output']>;
  expYear: Maybe<Scalars['Int']['output']>;
  id: Scalars['ID']['output'];
  isDefault: Maybe<Scalars['Boolean']['output']>;
  label: Maybe<Scalars['String']['output']>;
  last4: Maybe<Scalars['String']['output']>;
};

export type PaymentStatus =
  | 'CAPTURED'
  | 'FAILED'
  | 'PENDING'
  | 'REFUNDED';

export type PlanStatus =
  | 'ACTIVE'
  | 'ARCHIVED'
  | 'DRAFT';

export type PriceTier = {
  __typename?: 'PriceTier';
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  planId: Scalars['ID']['output'];
  price: Scalars['String']['output'];
};

export type Query = {
  __typename?: 'Query';
  admissionPass: Maybe<AdmissionPass>;
  attendancePolicy: Maybe<AttendancePolicy>;
  attendanceSummary: Maybe<AttendanceSummary>;
  currentUser: Maybe<User>;
  eventCheckins: Array<EventCheckin>;
  order: Maybe<Order>;
  orders: Array<Order>;
  payment: Maybe<Payment>;
  savedEvents: SavedEventConnection;
  seatingPlan: Maybe<SeatingPlan>;
  seatingPlans: Array<SeatingPlan>;
  sessions: Array<Session>;
  ticket: Maybe<Ticket>;
  tickets: Array<Ticket>;
  ticketsConnection: TicketConnection;
  userLookup: Maybe<UserLookupResult>;
  venue: Maybe<Venue>;
  venues: Array<Venue>;
};


export type QueryAdmissionPassArgs = {
  orderId?: InputMaybe<Scalars['ID']['input']>;
  ticketId: Scalars['ID']['input'];
};


export type QueryAttendancePolicyArgs = {
  eventId: Scalars['ID']['input'];
};


export type QueryAttendanceSummaryArgs = {
  eventId: Scalars['ID']['input'];
};


export type QueryEventCheckinsArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  eventId: Scalars['ID']['input'];
  first?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryOrderArgs = {
  id: Scalars['ID']['input'];
};


export type QueryPaymentArgs = {
  id: Scalars['ID']['input'];
};


export type QuerySavedEventsArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
};


export type QuerySeatingPlanArgs = {
  id: Scalars['ID']['input'];
};


export type QuerySeatingPlansArgs = {
  venueId: Scalars['ID']['input'];
};


export type QueryTicketArgs = {
  id: Scalars['ID']['input'];
};


export type QueryTicketsConnectionArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  filter?: InputMaybe<TicketFilter>;
  first?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryUserLookupArgs = {
  email?: InputMaybe<Scalars['String']['input']>;
  id?: InputMaybe<Scalars['ID']['input']>;
};


export type QueryVenueArgs = {
  id: Scalars['ID']['input'];
};

export type RecordCheckinByUserIdInput = {
  eventId: Scalars['ID']['input'];
  userId: Scalars['ID']['input'];
};

export type RecordCheckinInput = {
  source: CheckinSource;
  ticketId: Scalars['ID']['input'];
};

export type RegisterPaymentMethodInput = {
  consentAccepted: Scalars['Boolean']['input'];
  consentVersion: Scalars['String']['input'];
  providerPaymentMethodId: Scalars['String']['input'];
  setAsDefault?: InputMaybe<Scalars['Boolean']['input']>;
};

export type SavedEventConnection = {
  __typename?: 'SavedEventConnection';
  edges: Array<SavedEventEdge>;
  pageInfo: PageInfo;
};

export type SavedEventEdge = {
  __typename?: 'SavedEventEdge';
  cursor: Scalars['String']['output'];
  node: Ticket;
};

export type ScanValidationResult = {
  __typename?: 'ScanValidationResult';
  eventId: Maybe<Scalars['ID']['output']>;
  orderId: Maybe<Scalars['ID']['output']>;
  reason: Maybe<Scalars['String']['output']>;
  ticketId: Maybe<Scalars['ID']['output']>;
  valid: Scalars['Boolean']['output'];
};

export type Seat = {
  __typename?: 'Seat';
  id: Scalars['ID']['output'];
  label: Scalars['String']['output'];
  price: Scalars['Int']['output'];
  status: SeatStatus;
};

export type SeatHoldResult = {
  __typename?: 'SeatHoldResult';
  expiresAt: Scalars['String']['output'];
  held: Array<Scalars['ID']['output']>;
};

export type SeatStatus =
  | 'AVAILABLE'
  | 'HELD'
  | 'SOLD';

export type SeatingPlan = {
  __typename?: 'SeatingPlan';
  assignmentMode: AssignmentMode;
  id: Scalars['ID']['output'];
  sections: Array<Section>;
  status: PlanStatus;
};

export type Section = {
  __typename?: 'Section';
  availableSeats: Scalars['Int']['output'];
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  seats: Array<Seat>;
};

export type SectionType =
  | 'GA'
  | 'SEATED';

export type Session = {
  __typename?: 'Session';
  createdAt: Scalars['String']['output'];
  current: Scalars['Boolean']['output'];
  id: Scalars['ID']['output'];
  ipAddress: Maybe<Scalars['String']['output']>;
  lastUsedAt: Maybe<Scalars['String']['output']>;
  userAgent: Maybe<Scalars['String']['output']>;
};

export type Ticket = {
  __typename?: 'Ticket';
  available: Scalars['Int']['output'];
  createdAt: Scalars['String']['output'];
  event: Maybe<TicketEvent>;
  id: Scalars['ID']['output'];
  maxPerUser: Maybe<Scalars['Int']['output']>;
  orderId: Maybe<Scalars['ID']['output']>;
  price: Scalars['Int']['output'];
  priceDecimal: Scalars['String']['output'];
  quota: Scalars['Int']['output'];
  reserved: Scalars['Int']['output'];
  savedByMe: Scalars['Boolean']['output'];
  seatingPlan: Maybe<SeatingPlan>;
  sold: Scalars['Int']['output'];
  ticketType: TicketType;
  title: Scalars['String']['output'];
  updatedAt: Scalars['String']['output'];
  userId: Scalars['ID']['output'];
};

export type TicketConnection = {
  __typename?: 'TicketConnection';
  edges: Array<TicketEdge>;
  pageInfo: PageInfo;
};

export type TicketEdge = {
  __typename?: 'TicketEdge';
  cursor: Scalars['String']['output'];
  node: Ticket;
};

export type TicketEvent = {
  __typename?: 'TicketEvent';
  description: Maybe<Scalars['String']['output']>;
  endsAt: Maybe<Scalars['String']['output']>;
  imageUrl: Maybe<Scalars['String']['output']>;
  startsAt: Scalars['String']['output'];
  title: Scalars['String']['output'];
  venueAddress: Maybe<Scalars['String']['output']>;
  venueName: Maybe<Scalars['String']['output']>;
};

export type TicketEventInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  endsAt?: InputMaybe<Scalars['String']['input']>;
  imageUrl?: InputMaybe<Scalars['String']['input']>;
  startsAt: Scalars['String']['input'];
  title?: InputMaybe<Scalars['String']['input']>;
  venueAddress?: InputMaybe<Scalars['String']['input']>;
  venueName?: InputMaybe<Scalars['String']['input']>;
};

export type TicketFilter = {
  availableOnly?: InputMaybe<Scalars['Boolean']['input']>;
  ticketType?: InputMaybe<TicketType>;
};

export type TicketType =
  | 'GENERAL_ADMISSION'
  | 'SEATED';

export type UpdateAttendancePolicyInput = {
  allowManualOverride?: InputMaybe<Scalars['Boolean']['input']>;
  requireQrForEntry?: InputMaybe<Scalars['Boolean']['input']>;
};

export type UpdatePreferencesInput = {
  marketingOptIn?: InputMaybe<Scalars['Boolean']['input']>;
  orderUpdates?: InputMaybe<Scalars['Boolean']['input']>;
  productUpdates?: InputMaybe<Scalars['Boolean']['input']>;
};

export type UpdateProfileInput = {
  displayName?: InputMaybe<Scalars['String']['input']>;
  locale?: InputMaybe<Scalars['String']['input']>;
  timezone?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateSeatingPlanInput = {
  assignmentMode?: InputMaybe<AssignmentMode>;
  maxSeatsPerOrder?: InputMaybe<Scalars['Int']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  pricingMode?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateSectionInput = {
  columnCount?: InputMaybe<Scalars['Int']['input']>;
  displayOrder?: InputMaybe<Scalars['Int']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  rowCount?: InputMaybe<Scalars['Int']['input']>;
};

export type UpdateTicketInput = {
  event?: InputMaybe<TicketEventInput>;
  maxPerUser?: InputMaybe<Scalars['Int']['input']>;
  price?: InputMaybe<Scalars['Int']['input']>;
  quota?: InputMaybe<Scalars['Int']['input']>;
  seatingPlanId?: InputMaybe<Scalars['ID']['input']>;
  title?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateVenueInput = {
  address?: InputMaybe<Scalars['String']['input']>;
  capacity: Scalars['Int']['input'];
  name: Scalars['String']['input'];
  timezone: Scalars['String']['input'];
};

export type User = {
  __typename?: 'User';
  billingAddress: Maybe<BillingAddress>;
  email: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  orders: Array<Order>;
  paymentMethods: Array<PaymentMethod>;
  preferences: Maybe<UserPreferences>;
  profile: Maybe<UserProfile>;
};

export type UserLookupResult = {
  __typename?: 'UserLookupResult';
  displayName: Maybe<Scalars['String']['output']>;
  email: Scalars['String']['output'];
  id: Scalars['ID']['output'];
};

export type UserPreferences = {
  __typename?: 'UserPreferences';
  marketingOptIn: Maybe<Scalars['Boolean']['output']>;
  orderUpdates: Maybe<Scalars['Boolean']['output']>;
  productUpdates: Maybe<Scalars['Boolean']['output']>;
};

export type UserProfile = {
  __typename?: 'UserProfile';
  billingAddress: Maybe<BillingAddress>;
  displayName: Maybe<Scalars['String']['output']>;
  locale: Maybe<Scalars['String']['output']>;
  timezone: Maybe<Scalars['String']['output']>;
};

export type Venue = {
  __typename?: 'Venue';
  address: Scalars['String']['output'];
  capacity: Scalars['Int']['output'];
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  organizerId: Scalars['ID']['output'];
  timezone: Scalars['String']['output'];
};

export type VenueSection = {
  __typename?: 'VenueSection';
  capacity: Scalars['Int']['output'];
  columnCount: Scalars['Int']['output'];
  displayOrder: Scalars['Int']['output'];
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  rowCount: Scalars['Int']['output'];
  type: SectionType;
  venueId: Scalars['ID']['output'];
};

export type Join__ContextArgument = {
  context: Scalars['String']['input'];
  name: Scalars['String']['input'];
  selection: Scalars['join__FieldValue']['input'];
  type: Scalars['String']['input'];
};

export type Join__Graph =
  | 'ATTENDANCE'
  | 'AUTH'
  | 'ORDERS'
  | 'PAYMENTS'
  | 'TICKETS'
  | 'USERS'
  | 'VENUES';

export type Link__Purpose =
  /** `EXECUTION` features provide metadata necessary for operation execution. */
  | 'EXECUTION'
  /** `SECURITY` features provide metadata necessary to securely resolve fields. */
  | 'SECURITY';

export type AdmissionPassQueryVariables = Exact<{
  ticketId: Scalars['ID']['input'];
  orderId?: InputMaybe<Scalars['ID']['input']>;
}>;


export type AdmissionPassQuery = { __typename?: 'Query', admissionPass: { __typename?: 'AdmissionPass', id: string, ticketId: string, orderId: string, eventId: string, status: CredentialStatus, issuedAt: string, usedAt: string | null, qrToken: string | null } | null };

export type AttendancePageQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type AttendancePageQuery = { __typename?: 'Query', ticket: { __typename?: 'Ticket', id: string, title: string, userId: string, sold: number } | null, attendancePolicy: { __typename?: 'AttendancePolicy', eventId: string, requireQrForEntry: boolean, allowManualOverride: boolean } | null, attendanceSummary: { __typename?: 'AttendanceSummary', eventId: string, totalAdmitted: number, totalDenied: number, totalCheckedIn: number } | null, eventCheckins: Array<{ __typename?: 'EventCheckin', id: string, eventId: string, ticketId: string, orderId: string, userId: string | null, checkedInAt: string, source: CheckinSource }> };

export type AttendancePolicyQueryVariables = Exact<{
  eventId: Scalars['ID']['input'];
}>;


export type AttendancePolicyQuery = { __typename?: 'Query', attendancePolicy: { __typename?: 'AttendancePolicy', eventId: string, requireQrForEntry: boolean, allowManualOverride: boolean } | null };

export type AttendanceSummaryQueryVariables = Exact<{
  eventId: Scalars['ID']['input'];
}>;


export type AttendanceSummaryQuery = { __typename?: 'Query', attendanceSummary: { __typename?: 'AttendanceSummary', eventId: string, totalAdmitted: number, totalDenied: number, totalCheckedIn: number } | null };

export type EventCheckinsQueryVariables = Exact<{
  eventId: Scalars['ID']['input'];
}>;


export type EventCheckinsQuery = { __typename?: 'Query', eventCheckins: Array<{ __typename?: 'EventCheckin', id: string, eventId: string, ticketId: string, orderId: string, userId: string | null, checkedInAt: string, source: CheckinSource }> };

export type RecordCheckinMutationVariables = Exact<{
  input: RecordCheckinInput;
}>;


export type RecordCheckinMutation = { __typename?: 'Mutation', recordCheckin: { __typename?: 'EventCheckin', id: string, eventId: string, ticketId: string, orderId: string, checkedInAt: string, source: CheckinSource } };

export type RecordCheckinByUserIdMutationVariables = Exact<{
  input: RecordCheckinByUserIdInput;
}>;


export type RecordCheckinByUserIdMutation = { __typename?: 'Mutation', recordCheckinByUserId: { __typename?: 'EventCheckin', id: string, eventId: string, ticketId: string, orderId: string, checkedInAt: string, source: CheckinSource } };

export type UpdateAttendancePolicyMutationVariables = Exact<{
  eventId: Scalars['ID']['input'];
  input: UpdateAttendancePolicyInput;
}>;


export type UpdateAttendancePolicyMutation = { __typename?: 'Mutation', updateAttendancePolicy: { __typename?: 'AttendancePolicy', eventId: string, requireQrForEntry: boolean, allowManualOverride: boolean } };

export type ValidateScanMutationVariables = Exact<{
  token: Scalars['String']['input'];
}>;


export type ValidateScanMutation = { __typename?: 'Mutation', validateScan: { __typename?: 'ScanValidationResult', valid: boolean, reason: string | null, ticketId: string | null, orderId: string | null, eventId: string | null } };

export type CancelOrderMutationVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type CancelOrderMutation = { __typename?: 'Mutation', cancelOrder: { __typename?: 'Order', id: string } };

export type CreateOrderMutationVariables = Exact<{
  input: CreateOrderInput;
}>;


export type CreateOrderMutation = { __typename?: 'Mutation', createOrder: { __typename?: 'Order', id: string } };

export type CreateSeatedOrderMutationVariables = Exact<{
  input: CreateSeatedOrderInput;
}>;


export type CreateSeatedOrderMutation = { __typename?: 'Mutation', createSeatedOrder: { __typename?: 'Order', id: string } };

export type OrderDetailQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type OrderDetailQuery = { __typename?: 'Query', order: { __typename?: 'Order', id: string, userId: string, status: OrderStatus, quantity: number, expiresAt: string | null, createdAt: string, ticket: { __typename?: 'OrderTicket', id: string, title: string, price: string } } | null };

export type OrderPageQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type OrderPageQuery = { __typename?: 'Query', order: { __typename?: 'Order', id: string, userId: string, status: OrderStatus, quantity: number, expiresAt: string | null, createdAt: string, ticket: { __typename?: 'OrderTicket', id: string, title: string, price: string } } | null, currentUser: { __typename?: 'User', id: string, paymentMethods: Array<{ __typename?: 'PaymentMethod', id: string, brand: string | null, label: string | null, last4: string | null, expMonth: number | null, expYear: number | null, isDefault: boolean | null }> } | null };

export type OrdersPageQueryVariables = Exact<{ [key: string]: never; }>;


export type OrdersPageQuery = { __typename?: 'Query', orders: Array<{ __typename?: 'Order', id: string, userId: string, status: OrderStatus, quantity: number, expiresAt: string | null, createdAt: string, ticket: { __typename?: 'OrderTicket', id: string, title: string, price: string } }> };

export type CreatePaymentMutationVariables = Exact<{
  input: CreatePaymentInput;
}>;


export type CreatePaymentMutation = { __typename?: 'Mutation', createPayment: { __typename?: 'Payment', id: string, orderId: string, status: PaymentStatus } };

export type RegisterPaymentMethodMutationVariables = Exact<{
  input: RegisterPaymentMethodInput;
}>;


export type RegisterPaymentMethodMutation = { __typename?: 'Mutation', registerPaymentMethod: { __typename?: 'PaymentMethod', id: string, brand: string | null, last4: string | null, expMonth: number | null, expYear: number | null, isDefault: boolean | null, label: string | null } };

export type HoldSeatsMutationVariables = Exact<{
  planId: Scalars['ID']['input'];
  seatIds: Array<Scalars['ID']['input']> | Scalars['ID']['input'];
}>;


export type HoldSeatsMutation = { __typename?: 'Mutation', holdSeats: { __typename?: 'SeatHoldResult', held: Array<string>, expiresAt: string } };

export type ReleaseSeatsMutationVariables = Exact<{
  planId: Scalars['ID']['input'];
  seatIds: Array<Scalars['ID']['input']> | Scalars['ID']['input'];
}>;


export type ReleaseSeatsMutation = { __typename?: 'Mutation', releaseSeats: boolean };

export type SeatingPlanAvailabilityQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type SeatingPlanAvailabilityQuery = { __typename?: 'Query', seatingPlan: { __typename?: 'SeatingPlan', sections: Array<{ __typename?: 'Section', id: string, availableSeats: number, seats: Array<{ __typename?: 'Seat', id: string, label: string, status: SeatStatus }> }> } | null };

export type DeletePaymentMethodMutationVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type DeletePaymentMethodMutation = { __typename?: 'Mutation', deletePaymentMethod: boolean };

export type RevokeSessionMutationVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type RevokeSessionMutation = { __typename?: 'Mutation', revokeSession: boolean };

export type SetDefaultPaymentMethodMutationVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type SetDefaultPaymentMethodMutation = { __typename?: 'Mutation', setDefaultPaymentMethod: { __typename?: 'PaymentMethod', id: string, brand: string | null, label: string | null, last4: string | null, expMonth: number | null, expYear: number | null, isDefault: boolean | null } };

export type SettingsPageQueryVariables = Exact<{ [key: string]: never; }>;


export type SettingsPageQuery = { __typename?: 'Query', currentUser: { __typename?: 'User', id: string, profile: { __typename?: 'UserProfile', displayName: string | null, locale: string | null, timezone: string | null } | null, preferences: { __typename?: 'UserPreferences', marketingOptIn: boolean | null, orderUpdates: boolean | null, productUpdates: boolean | null } | null, billingAddress: { __typename?: 'BillingAddress', line1: string | null, line2: string | null, city: string | null, state: string | null, postalCode: string | null, country: string | null } | null, paymentMethods: Array<{ __typename?: 'PaymentMethod', id: string, brand: string | null, label: string | null, last4: string | null, expMonth: number | null, expYear: number | null, isDefault: boolean | null }> } | null, sessions: Array<{ __typename?: 'Session', id: string, userAgent: string | null, ipAddress: string | null, createdAt: string, lastUsedAt: string | null, current: boolean }>, orders: Array<{ __typename?: 'Order', id: string, status: OrderStatus, createdAt: string }> };

export type UpdateBillingAddressMutationVariables = Exact<{
  input: BillingAddressInput;
}>;


export type UpdateBillingAddressMutation = { __typename?: 'Mutation', updateBillingAddress: { __typename?: 'BillingAddress', line1: string | null, line2: string | null, city: string | null, state: string | null, postalCode: string | null, country: string | null } };

export type UpdatePreferencesMutationVariables = Exact<{
  input: UpdatePreferencesInput;
}>;


export type UpdatePreferencesMutation = { __typename?: 'Mutation', updatePreferences: { __typename?: 'UserPreferences', marketingOptIn: boolean | null, orderUpdates: boolean | null, productUpdates: boolean | null } };

export type UpdateProfileMutationVariables = Exact<{
  input: UpdateProfileInput;
}>;


export type UpdateProfileMutation = { __typename?: 'Mutation', updateProfile: { __typename?: 'UserProfile', displayName: string | null, locale: string | null, timezone: string | null } };

export type CreateTicketMutationVariables = Exact<{
  input: CreateTicketInput;
}>;


export type CreateTicketMutation = { __typename?: 'Mutation', createTicket: { __typename?: 'Ticket', id: string, title: string, price: number, priceDecimal: string } };

export type OrganizerTicketsQueryVariables = Exact<{ [key: string]: never; }>;


export type OrganizerTicketsQuery = { __typename?: 'Query', tickets: Array<{ __typename?: 'Ticket', id: string, title: string, userId: string, priceDecimal: string, sold: number, available: number, ticketType: TicketType, event: { __typename?: 'TicketEvent', title: string, startsAt: string, venueName: string | null, venueAddress: string | null } | null }> };

export type SaveEventMutationVariables = Exact<{
  eventId: Scalars['ID']['input'];
}>;


export type SaveEventMutation = { __typename?: 'Mutation', saveEvent: { __typename?: 'Ticket', id: string, savedByMe: boolean } };

export type SavedEventsQueryVariables = Exact<{
  first?: InputMaybe<Scalars['Int']['input']>;
  after?: InputMaybe<Scalars['String']['input']>;
}>;


export type SavedEventsQuery = { __typename?: 'Query', savedEvents: { __typename?: 'SavedEventConnection', edges: Array<{ __typename?: 'SavedEventEdge', cursor: string, node: { __typename?: 'Ticket', id: string, title: string, priceDecimal: string, savedByMe: boolean, event: { __typename?: 'TicketEvent', title: string, startsAt: string, imageUrl: string | null, venueName: string | null, venueAddress: string | null } | null } }>, pageInfo: { __typename?: 'PageInfo', hasNextPage: boolean, endCursor: string | null } } };

export type TicketDetailQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type TicketDetailQuery = { __typename?: 'Query', ticket: { __typename?: 'Ticket', id: string, title: string, price: number, priceDecimal: string, userId: string, orderId: string | null, quota: number, reserved: number, sold: number, available: number, maxPerUser: number | null, ticketType: TicketType, savedByMe: boolean, seatingPlan: { __typename?: 'SeatingPlan', id: string } | null, event: { __typename?: 'TicketEvent', title: string, description: string | null, startsAt: string, endsAt: string | null, imageUrl: string | null, venueName: string | null, venueAddress: string | null } | null } | null };

export type TicketsBrowseQueryVariables = Exact<{
  first?: InputMaybe<Scalars['Int']['input']>;
  after?: InputMaybe<Scalars['String']['input']>;
}>;


export type TicketsBrowseQuery = { __typename?: 'Query', ticketsConnection: { __typename?: 'TicketConnection', edges: Array<{ __typename?: 'TicketEdge', cursor: string, node: { __typename?: 'Ticket', id: string, title: string, price: number, available: number, ticketType: TicketType, seatingPlan: { __typename?: 'SeatingPlan', id: string } | null, event: { __typename?: 'TicketEvent', title: string, startsAt: string, venueName: string | null } | null } }>, pageInfo: { __typename?: 'PageInfo', hasNextPage: boolean, endCursor: string | null } } };

export type UnsaveEventMutationVariables = Exact<{
  eventId: Scalars['ID']['input'];
}>;


export type UnsaveEventMutation = { __typename?: 'Mutation', unsaveEvent: { __typename?: 'Ticket', id: string, savedByMe: boolean } };

export type UpdateTicketMutationVariables = Exact<{
  id: Scalars['ID']['input'];
  input: UpdateTicketInput;
}>;


export type UpdateTicketMutation = { __typename?: 'Mutation', updateTicket: { __typename?: 'Ticket', id: string, title: string, price: number, priceDecimal: string } };

export type UserLookupQueryVariables = Exact<{
  email?: InputMaybe<Scalars['String']['input']>;
  id?: InputMaybe<Scalars['ID']['input']>;
}>;


export type UserLookupQuery = { __typename?: 'Query', userLookup: { __typename?: 'UserLookupResult', id: string, email: string, displayName: string | null } | null };

export type ActivateSeatingPlanMutationVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type ActivateSeatingPlanMutation = { __typename?: 'Mutation', activateSeatingPlan: { __typename?: 'SeatingPlan', id: string, status: PlanStatus, assignmentMode: AssignmentMode } };

export type CreatePriceTierMutationVariables = Exact<{
  planId: Scalars['ID']['input'];
  input: CreatePriceTierInput;
}>;


export type CreatePriceTierMutation = { __typename?: 'Mutation', createPriceTier: { __typename?: 'PriceTier', id: string, planId: string, name: string, price: string } };

export type CreateSeatingPlanMutationVariables = Exact<{
  input: CreateSeatingPlanInput;
}>;


export type CreateSeatingPlanMutation = { __typename?: 'Mutation', createSeatingPlan: { __typename?: 'SeatingPlan', id: string, status: PlanStatus, assignmentMode: AssignmentMode } };

export type CreateVenueMutationVariables = Exact<{
  input: CreateVenueInput;
}>;


export type CreateVenueMutation = { __typename?: 'Mutation', createVenue: { __typename?: 'Venue', id: string, organizerId: string, name: string, capacity: number, timezone: string, address: string } };

export type CreateVenueSectionMutationVariables = Exact<{
  venueId: Scalars['ID']['input'];
  input: CreateSectionInput;
}>;


export type CreateVenueSectionMutation = { __typename?: 'Mutation', createSection: { __typename?: 'VenueSection', id: string, venueId: string, name: string, type: SectionType, rowCount: number, columnCount: number, displayOrder: number, capacity: number } };

export type DeactivateSeatingPlanMutationVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type DeactivateSeatingPlanMutation = { __typename?: 'Mutation', deactivateSeatingPlan: { __typename?: 'SeatingPlan', id: string, status: PlanStatus, assignmentMode: AssignmentMode } };

export type UpdateSeatingPlanMutationVariables = Exact<{
  id: Scalars['ID']['input'];
  input: UpdateSeatingPlanInput;
}>;


export type UpdateSeatingPlanMutation = { __typename?: 'Mutation', updateSeatingPlan: { __typename?: 'SeatingPlan', id: string, status: PlanStatus, assignmentMode: AssignmentMode } };

export type UpdateVenueMutationVariables = Exact<{
  id: Scalars['ID']['input'];
  input: UpdateVenueInput;
}>;


export type UpdateVenueMutation = { __typename?: 'Mutation', updateVenue: { __typename?: 'Venue', id: string, name: string, capacity: number, timezone: string, address: string } };

export type UpdateVenueSectionMutationVariables = Exact<{
  id: Scalars['ID']['input'];
  input: UpdateSectionInput;
}>;


export type UpdateVenueSectionMutation = { __typename?: 'Mutation', updateSection: { __typename?: 'VenueSection', id: string, venueId: string, name: string, type: SectionType, rowCount: number, columnCount: number, displayOrder: number, capacity: number } };

export type VenueDetailQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type VenueDetailQuery = { __typename?: 'Query', venue: { __typename?: 'Venue', id: string, organizerId: string, name: string, capacity: number, timezone: string, address: string } | null };

export type VenuesListQueryVariables = Exact<{ [key: string]: never; }>;


export type VenuesListQuery = { __typename?: 'Query', venues: Array<{ __typename?: 'Venue', id: string, organizerId: string, name: string, capacity: number, timezone: string, address: string }> };


export const AdmissionPassDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"AdmissionPass"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"ticketId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"orderId"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"admissionPass"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"ticketId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"ticketId"}}},{"kind":"Argument","name":{"kind":"Name","value":"orderId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"orderId"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"ticketId"}},{"kind":"Field","name":{"kind":"Name","value":"orderId"}},{"kind":"Field","name":{"kind":"Name","value":"eventId"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"issuedAt"}},{"kind":"Field","name":{"kind":"Name","value":"usedAt"}},{"kind":"Field","name":{"kind":"Name","value":"qrToken"}}]}}]}}]} as unknown as DocumentNode<AdmissionPassQuery, AdmissionPassQueryVariables>;
export const AttendancePageDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"AttendancePage"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"ticket"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"sold"}}]}},{"kind":"Field","name":{"kind":"Name","value":"attendancePolicy"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"eventId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"eventId"}},{"kind":"Field","name":{"kind":"Name","value":"requireQrForEntry"}},{"kind":"Field","name":{"kind":"Name","value":"allowManualOverride"}}]}},{"kind":"Field","name":{"kind":"Name","value":"attendanceSummary"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"eventId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"eventId"}},{"kind":"Field","name":{"kind":"Name","value":"totalAdmitted"}},{"kind":"Field","name":{"kind":"Name","value":"totalDenied"}},{"kind":"Field","name":{"kind":"Name","value":"totalCheckedIn"}}]}},{"kind":"Field","name":{"kind":"Name","value":"eventCheckins"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"eventId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"eventId"}},{"kind":"Field","name":{"kind":"Name","value":"ticketId"}},{"kind":"Field","name":{"kind":"Name","value":"orderId"}},{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"checkedInAt"}},{"kind":"Field","name":{"kind":"Name","value":"source"}}]}}]}}]} as unknown as DocumentNode<AttendancePageQuery, AttendancePageQueryVariables>;
export const AttendancePolicyDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"AttendancePolicy"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"eventId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"attendancePolicy"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"eventId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"eventId"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"eventId"}},{"kind":"Field","name":{"kind":"Name","value":"requireQrForEntry"}},{"kind":"Field","name":{"kind":"Name","value":"allowManualOverride"}}]}}]}}]} as unknown as DocumentNode<AttendancePolicyQuery, AttendancePolicyQueryVariables>;
export const AttendanceSummaryDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"AttendanceSummary"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"eventId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"attendanceSummary"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"eventId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"eventId"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"eventId"}},{"kind":"Field","name":{"kind":"Name","value":"totalAdmitted"}},{"kind":"Field","name":{"kind":"Name","value":"totalDenied"}},{"kind":"Field","name":{"kind":"Name","value":"totalCheckedIn"}}]}}]}}]} as unknown as DocumentNode<AttendanceSummaryQuery, AttendanceSummaryQueryVariables>;
export const EventCheckinsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"EventCheckins"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"eventId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"eventCheckins"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"eventId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"eventId"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"eventId"}},{"kind":"Field","name":{"kind":"Name","value":"ticketId"}},{"kind":"Field","name":{"kind":"Name","value":"orderId"}},{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"checkedInAt"}},{"kind":"Field","name":{"kind":"Name","value":"source"}}]}}]}}]} as unknown as DocumentNode<EventCheckinsQuery, EventCheckinsQueryVariables>;
export const RecordCheckinDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"RecordCheckin"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"RecordCheckinInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"recordCheckin"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"eventId"}},{"kind":"Field","name":{"kind":"Name","value":"ticketId"}},{"kind":"Field","name":{"kind":"Name","value":"orderId"}},{"kind":"Field","name":{"kind":"Name","value":"checkedInAt"}},{"kind":"Field","name":{"kind":"Name","value":"source"}}]}}]}}]} as unknown as DocumentNode<RecordCheckinMutation, RecordCheckinMutationVariables>;
export const RecordCheckinByUserIdDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"RecordCheckinByUserId"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"RecordCheckinByUserIdInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"recordCheckinByUserId"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"eventId"}},{"kind":"Field","name":{"kind":"Name","value":"ticketId"}},{"kind":"Field","name":{"kind":"Name","value":"orderId"}},{"kind":"Field","name":{"kind":"Name","value":"checkedInAt"}},{"kind":"Field","name":{"kind":"Name","value":"source"}}]}}]}}]} as unknown as DocumentNode<RecordCheckinByUserIdMutation, RecordCheckinByUserIdMutationVariables>;
export const UpdateAttendancePolicyDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateAttendancePolicy"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"eventId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateAttendancePolicyInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateAttendancePolicy"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"eventId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"eventId"}}},{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"eventId"}},{"kind":"Field","name":{"kind":"Name","value":"requireQrForEntry"}},{"kind":"Field","name":{"kind":"Name","value":"allowManualOverride"}}]}}]}}]} as unknown as DocumentNode<UpdateAttendancePolicyMutation, UpdateAttendancePolicyMutationVariables>;
export const ValidateScanDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"ValidateScan"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"token"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"validateScan"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"token"},"value":{"kind":"Variable","name":{"kind":"Name","value":"token"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"valid"}},{"kind":"Field","name":{"kind":"Name","value":"reason"}},{"kind":"Field","name":{"kind":"Name","value":"ticketId"}},{"kind":"Field","name":{"kind":"Name","value":"orderId"}},{"kind":"Field","name":{"kind":"Name","value":"eventId"}}]}}]}}]} as unknown as DocumentNode<ValidateScanMutation, ValidateScanMutationVariables>;
export const CancelOrderDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CancelOrder"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"cancelOrder"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}}]}}]} as unknown as DocumentNode<CancelOrderMutation, CancelOrderMutationVariables>;
export const CreateOrderDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreateOrder"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreateOrderInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createOrder"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}}]}}]} as unknown as DocumentNode<CreateOrderMutation, CreateOrderMutationVariables>;
export const CreateSeatedOrderDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreateSeatedOrder"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreateSeatedOrderInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createSeatedOrder"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}}]}}]} as unknown as DocumentNode<CreateSeatedOrderMutation, CreateSeatedOrderMutationVariables>;
export const OrderDetailDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"OrderDetail"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"order"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"quantity"}},{"kind":"Field","name":{"kind":"Name","value":"expiresAt"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"ticket"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"price"}}]}}]}}]}}]} as unknown as DocumentNode<OrderDetailQuery, OrderDetailQueryVariables>;
export const OrderPageDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"OrderPage"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"order"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"quantity"}},{"kind":"Field","name":{"kind":"Name","value":"expiresAt"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"ticket"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"price"}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"currentUser"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"paymentMethods"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"last4"}},{"kind":"Field","name":{"kind":"Name","value":"expMonth"}},{"kind":"Field","name":{"kind":"Name","value":"expYear"}},{"kind":"Field","name":{"kind":"Name","value":"isDefault"}}]}}]}}]}}]} as unknown as DocumentNode<OrderPageQuery, OrderPageQueryVariables>;
export const OrdersPageDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"OrdersPage"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"orders"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"quantity"}},{"kind":"Field","name":{"kind":"Name","value":"expiresAt"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"ticket"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"price"}}]}}]}}]}}]} as unknown as DocumentNode<OrdersPageQuery, OrdersPageQueryVariables>;
export const CreatePaymentDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreatePayment"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreatePaymentInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createPayment"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"orderId"}},{"kind":"Field","name":{"kind":"Name","value":"status"}}]}}]}}]} as unknown as DocumentNode<CreatePaymentMutation, CreatePaymentMutationVariables>;
export const RegisterPaymentMethodDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"RegisterPaymentMethod"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"RegisterPaymentMethodInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"registerPaymentMethod"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"last4"}},{"kind":"Field","name":{"kind":"Name","value":"expMonth"}},{"kind":"Field","name":{"kind":"Name","value":"expYear"}},{"kind":"Field","name":{"kind":"Name","value":"isDefault"}},{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}}]} as unknown as DocumentNode<RegisterPaymentMethodMutation, RegisterPaymentMethodMutationVariables>;
export const HoldSeatsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"HoldSeats"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"planId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"seatIds"}},"type":{"kind":"NonNullType","type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"holdSeats"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"planId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"planId"}}},{"kind":"Argument","name":{"kind":"Name","value":"seatIds"},"value":{"kind":"Variable","name":{"kind":"Name","value":"seatIds"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"held"}},{"kind":"Field","name":{"kind":"Name","value":"expiresAt"}}]}}]}}]} as unknown as DocumentNode<HoldSeatsMutation, HoldSeatsMutationVariables>;
export const ReleaseSeatsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"ReleaseSeats"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"planId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"seatIds"}},"type":{"kind":"NonNullType","type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"releaseSeats"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"planId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"planId"}}},{"kind":"Argument","name":{"kind":"Name","value":"seatIds"},"value":{"kind":"Variable","name":{"kind":"Name","value":"seatIds"}}}]}]}}]} as unknown as DocumentNode<ReleaseSeatsMutation, ReleaseSeatsMutationVariables>;
export const SeatingPlanAvailabilityDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"SeatingPlanAvailability"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"seatingPlan"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"sections"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"availableSeats"}},{"kind":"Field","name":{"kind":"Name","value":"seats"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"status"}}]}}]}}]}}]}}]} as unknown as DocumentNode<SeatingPlanAvailabilityQuery, SeatingPlanAvailabilityQueryVariables>;
export const DeletePaymentMethodDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DeletePaymentMethod"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"deletePaymentMethod"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}]}]}}]} as unknown as DocumentNode<DeletePaymentMethodMutation, DeletePaymentMethodMutationVariables>;
export const RevokeSessionDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"RevokeSession"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"revokeSession"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}]}]}}]} as unknown as DocumentNode<RevokeSessionMutation, RevokeSessionMutationVariables>;
export const SetDefaultPaymentMethodDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"SetDefaultPaymentMethod"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"setDefaultPaymentMethod"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"last4"}},{"kind":"Field","name":{"kind":"Name","value":"expMonth"}},{"kind":"Field","name":{"kind":"Name","value":"expYear"}},{"kind":"Field","name":{"kind":"Name","value":"isDefault"}}]}}]}}]} as unknown as DocumentNode<SetDefaultPaymentMethodMutation, SetDefaultPaymentMethodMutationVariables>;
export const SettingsPageDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"SettingsPage"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"currentUser"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"profile"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"displayName"}},{"kind":"Field","name":{"kind":"Name","value":"locale"}},{"kind":"Field","name":{"kind":"Name","value":"timezone"}}]}},{"kind":"Field","name":{"kind":"Name","value":"preferences"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"marketingOptIn"}},{"kind":"Field","name":{"kind":"Name","value":"orderUpdates"}},{"kind":"Field","name":{"kind":"Name","value":"productUpdates"}}]}},{"kind":"Field","name":{"kind":"Name","value":"billingAddress"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"line1"}},{"kind":"Field","name":{"kind":"Name","value":"line2"}},{"kind":"Field","name":{"kind":"Name","value":"city"}},{"kind":"Field","name":{"kind":"Name","value":"state"}},{"kind":"Field","name":{"kind":"Name","value":"postalCode"}},{"kind":"Field","name":{"kind":"Name","value":"country"}}]}},{"kind":"Field","name":{"kind":"Name","value":"paymentMethods"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"last4"}},{"kind":"Field","name":{"kind":"Name","value":"expMonth"}},{"kind":"Field","name":{"kind":"Name","value":"expYear"}},{"kind":"Field","name":{"kind":"Name","value":"isDefault"}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"sessions"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"userAgent"}},{"kind":"Field","name":{"kind":"Name","value":"ipAddress"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"lastUsedAt"}},{"kind":"Field","name":{"kind":"Name","value":"current"}}]}},{"kind":"Field","name":{"kind":"Name","value":"orders"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}}]}}]}}]} as unknown as DocumentNode<SettingsPageQuery, SettingsPageQueryVariables>;
export const UpdateBillingAddressDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateBillingAddress"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"BillingAddressInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateBillingAddress"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"line1"}},{"kind":"Field","name":{"kind":"Name","value":"line2"}},{"kind":"Field","name":{"kind":"Name","value":"city"}},{"kind":"Field","name":{"kind":"Name","value":"state"}},{"kind":"Field","name":{"kind":"Name","value":"postalCode"}},{"kind":"Field","name":{"kind":"Name","value":"country"}}]}}]}}]} as unknown as DocumentNode<UpdateBillingAddressMutation, UpdateBillingAddressMutationVariables>;
export const UpdatePreferencesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdatePreferences"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdatePreferencesInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updatePreferences"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"marketingOptIn"}},{"kind":"Field","name":{"kind":"Name","value":"orderUpdates"}},{"kind":"Field","name":{"kind":"Name","value":"productUpdates"}}]}}]}}]} as unknown as DocumentNode<UpdatePreferencesMutation, UpdatePreferencesMutationVariables>;
export const UpdateProfileDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateProfile"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateProfileInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateProfile"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"displayName"}},{"kind":"Field","name":{"kind":"Name","value":"locale"}},{"kind":"Field","name":{"kind":"Name","value":"timezone"}}]}}]}}]} as unknown as DocumentNode<UpdateProfileMutation, UpdateProfileMutationVariables>;
export const CreateTicketDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreateTicket"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreateTicketInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createTicket"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"price"}},{"kind":"Field","name":{"kind":"Name","value":"priceDecimal"}}]}}]}}]} as unknown as DocumentNode<CreateTicketMutation, CreateTicketMutationVariables>;
export const OrganizerTicketsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"OrganizerTickets"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"tickets"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"priceDecimal"}},{"kind":"Field","name":{"kind":"Name","value":"sold"}},{"kind":"Field","name":{"kind":"Name","value":"available"}},{"kind":"Field","name":{"kind":"Name","value":"ticketType"}},{"kind":"Field","name":{"kind":"Name","value":"event"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"startsAt"}},{"kind":"Field","name":{"kind":"Name","value":"venueName"}},{"kind":"Field","name":{"kind":"Name","value":"venueAddress"}}]}}]}}]}}]} as unknown as DocumentNode<OrganizerTicketsQuery, OrganizerTicketsQueryVariables>;
export const SaveEventDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"SaveEvent"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"eventId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"saveEvent"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"eventId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"eventId"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"savedByMe"}}]}}]}}]} as unknown as DocumentNode<SaveEventMutation, SaveEventMutationVariables>;
export const SavedEventsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"SavedEvents"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"first"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"after"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"savedEvents"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"Variable","name":{"kind":"Name","value":"first"}}},{"kind":"Argument","name":{"kind":"Name","value":"after"},"value":{"kind":"Variable","name":{"kind":"Name","value":"after"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"cursor"}},{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"priceDecimal"}},{"kind":"Field","name":{"kind":"Name","value":"savedByMe"}},{"kind":"Field","name":{"kind":"Name","value":"event"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"startsAt"}},{"kind":"Field","name":{"kind":"Name","value":"imageUrl"}},{"kind":"Field","name":{"kind":"Name","value":"venueName"}},{"kind":"Field","name":{"kind":"Name","value":"venueAddress"}}]}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"pageInfo"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"hasNextPage"}},{"kind":"Field","name":{"kind":"Name","value":"endCursor"}}]}}]}}]}}]} as unknown as DocumentNode<SavedEventsQuery, SavedEventsQueryVariables>;
export const TicketDetailDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"TicketDetail"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"ticket"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"price"}},{"kind":"Field","name":{"kind":"Name","value":"priceDecimal"}},{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"orderId"}},{"kind":"Field","name":{"kind":"Name","value":"quota"}},{"kind":"Field","name":{"kind":"Name","value":"reserved"}},{"kind":"Field","name":{"kind":"Name","value":"sold"}},{"kind":"Field","name":{"kind":"Name","value":"available"}},{"kind":"Field","name":{"kind":"Name","value":"maxPerUser"}},{"kind":"Field","name":{"kind":"Name","value":"ticketType"}},{"kind":"Field","name":{"kind":"Name","value":"savedByMe"}},{"kind":"Field","name":{"kind":"Name","value":"seatingPlan"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}},{"kind":"Field","name":{"kind":"Name","value":"event"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"startsAt"}},{"kind":"Field","name":{"kind":"Name","value":"endsAt"}},{"kind":"Field","name":{"kind":"Name","value":"imageUrl"}},{"kind":"Field","name":{"kind":"Name","value":"venueName"}},{"kind":"Field","name":{"kind":"Name","value":"venueAddress"}}]}}]}}]}}]} as unknown as DocumentNode<TicketDetailQuery, TicketDetailQueryVariables>;
export const TicketsBrowseDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"TicketsBrowse"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"first"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"after"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"ticketsConnection"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"filter"},"value":{"kind":"ObjectValue","fields":[{"kind":"ObjectField","name":{"kind":"Name","value":"availableOnly"},"value":{"kind":"BooleanValue","value":true}}]}},{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"Variable","name":{"kind":"Name","value":"first"}}},{"kind":"Argument","name":{"kind":"Name","value":"after"},"value":{"kind":"Variable","name":{"kind":"Name","value":"after"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"price"}},{"kind":"Field","name":{"kind":"Name","value":"available"}},{"kind":"Field","name":{"kind":"Name","value":"ticketType"}},{"kind":"Field","name":{"kind":"Name","value":"seatingPlan"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}},{"kind":"Field","name":{"kind":"Name","value":"event"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"startsAt"}},{"kind":"Field","name":{"kind":"Name","value":"venueName"}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"cursor"}}]}},{"kind":"Field","name":{"kind":"Name","value":"pageInfo"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"hasNextPage"}},{"kind":"Field","name":{"kind":"Name","value":"endCursor"}}]}}]}}]}}]} as unknown as DocumentNode<TicketsBrowseQuery, TicketsBrowseQueryVariables>;
export const UnsaveEventDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UnsaveEvent"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"eventId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"unsaveEvent"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"eventId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"eventId"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"savedByMe"}}]}}]}}]} as unknown as DocumentNode<UnsaveEventMutation, UnsaveEventMutationVariables>;
export const UpdateTicketDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateTicket"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateTicketInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateTicket"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}},{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"price"}},{"kind":"Field","name":{"kind":"Name","value":"priceDecimal"}}]}}]}}]} as unknown as DocumentNode<UpdateTicketMutation, UpdateTicketMutationVariables>;
export const UserLookupDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"UserLookup"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"email"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"userLookup"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"email"},"value":{"kind":"Variable","name":{"kind":"Name","value":"email"}}},{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"email"}},{"kind":"Field","name":{"kind":"Name","value":"displayName"}}]}}]}}]} as unknown as DocumentNode<UserLookupQuery, UserLookupQueryVariables>;
export const ActivateSeatingPlanDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"ActivateSeatingPlan"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"activateSeatingPlan"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"assignmentMode"}}]}}]}}]} as unknown as DocumentNode<ActivateSeatingPlanMutation, ActivateSeatingPlanMutationVariables>;
export const CreatePriceTierDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreatePriceTier"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"planId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreatePriceTierInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createPriceTier"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"planId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"planId"}}},{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"planId"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"price"}}]}}]}}]} as unknown as DocumentNode<CreatePriceTierMutation, CreatePriceTierMutationVariables>;
export const CreateSeatingPlanDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreateSeatingPlan"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreateSeatingPlanInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createSeatingPlan"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"assignmentMode"}}]}}]}}]} as unknown as DocumentNode<CreateSeatingPlanMutation, CreateSeatingPlanMutationVariables>;
export const CreateVenueDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreateVenue"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreateVenueInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createVenue"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"organizerId"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"capacity"}},{"kind":"Field","name":{"kind":"Name","value":"timezone"}},{"kind":"Field","name":{"kind":"Name","value":"address"}}]}}]}}]} as unknown as DocumentNode<CreateVenueMutation, CreateVenueMutationVariables>;
export const CreateVenueSectionDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreateVenueSection"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"venueId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreateSectionInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createSection"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"venueId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"venueId"}}},{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"venueId"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"type"}},{"kind":"Field","name":{"kind":"Name","value":"rowCount"}},{"kind":"Field","name":{"kind":"Name","value":"columnCount"}},{"kind":"Field","name":{"kind":"Name","value":"displayOrder"}},{"kind":"Field","name":{"kind":"Name","value":"capacity"}}]}}]}}]} as unknown as DocumentNode<CreateVenueSectionMutation, CreateVenueSectionMutationVariables>;
export const DeactivateSeatingPlanDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DeactivateSeatingPlan"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"deactivateSeatingPlan"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"assignmentMode"}}]}}]}}]} as unknown as DocumentNode<DeactivateSeatingPlanMutation, DeactivateSeatingPlanMutationVariables>;
export const UpdateSeatingPlanDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateSeatingPlan"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateSeatingPlanInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateSeatingPlan"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}},{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"assignmentMode"}}]}}]}}]} as unknown as DocumentNode<UpdateSeatingPlanMutation, UpdateSeatingPlanMutationVariables>;
export const UpdateVenueDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateVenue"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateVenueInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateVenue"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}},{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"capacity"}},{"kind":"Field","name":{"kind":"Name","value":"timezone"}},{"kind":"Field","name":{"kind":"Name","value":"address"}}]}}]}}]} as unknown as DocumentNode<UpdateVenueMutation, UpdateVenueMutationVariables>;
export const UpdateVenueSectionDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateVenueSection"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateSectionInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateSection"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}},{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"venueId"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"type"}},{"kind":"Field","name":{"kind":"Name","value":"rowCount"}},{"kind":"Field","name":{"kind":"Name","value":"columnCount"}},{"kind":"Field","name":{"kind":"Name","value":"displayOrder"}},{"kind":"Field","name":{"kind":"Name","value":"capacity"}}]}}]}}]} as unknown as DocumentNode<UpdateVenueSectionMutation, UpdateVenueSectionMutationVariables>;
export const VenueDetailDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"VenueDetail"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"venue"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"organizerId"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"capacity"}},{"kind":"Field","name":{"kind":"Name","value":"timezone"}},{"kind":"Field","name":{"kind":"Name","value":"address"}}]}}]}}]} as unknown as DocumentNode<VenueDetailQuery, VenueDetailQueryVariables>;
export const VenuesListDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"VenuesList"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"venues"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"organizerId"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"capacity"}},{"kind":"Field","name":{"kind":"Name","value":"timezone"}},{"kind":"Field","name":{"kind":"Name","value":"address"}}]}}]}}]} as unknown as DocumentNode<VenuesListQuery, VenuesListQueryVariables>;