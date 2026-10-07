import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { VenueClaim } from "../../database/schema";
import { AccountsRepository } from "./accounts.repository";
import { isUuid } from "./accounts.service";

const MAX_EVIDENCE = 2000;
const MAX_REASON = 500;
const MAX_VENUE_ID = 64;

// Claims only record who asked and who decided. Approval makes the claimant a
// venue manager; the venue's own verification state lives in venue-service.
@Injectable()
export class VenueClaimsService {
  constructor(private readonly repository: AccountsRepository) {}

  async submit(input: {
    userId: string;
    venueId: string;
    accountId?: string;
    evidenceText?: string;
  }): Promise<VenueClaim> {
    const venueId = input.venueId.trim();
    if (!venueId || venueId.length > MAX_VENUE_ID) {
      throw new BadRequestException("Choose a venue to claim");
    }
    const evidence = input.evidenceText?.trim() || undefined;
    if (evidence && evidence.length > MAX_EVIDENCE) {
      throw new BadRequestException("Evidence is too long");
    }
    if (input.accountId) {
      if (!isUuid(input.accountId)) {
        throw new BadRequestException("account_id is not a valid id");
      }
      if (
        !(await this.repository.findMembership(input.accountId, input.userId))
      ) {
        throw new ForbiddenException("You are not a member of that account");
      }
    }
    if (await this.repository.findPendingClaim(venueId, input.userId)) {
      throw new ConflictException(
        "You already have a pending claim for this venue",
      );
    }
    return this.repository.insertVenueClaim({
      venueId,
      claimantUserId: input.userId,
      claimantAccountId: input.accountId,
      evidenceText: evidence,
    });
  }

  async decide(input: {
    claimId: string;
    approve: boolean;
    decidedBy: string;
    reason: string;
  }): Promise<VenueClaim> {
    if (!isUuid(input.claimId)) {
      throw new BadRequestException("claim_id is not a valid id");
    }
    const reason = input.reason.trim();
    if (!reason || reason.length > MAX_REASON) {
      throw new BadRequestException("Give a reason for this decision");
    }
    const result = await this.repository.decideVenueClaim({ ...input, reason });
    if (result.outcome === "DECIDED") return result.claim;
    if (result.outcome === "NOT_FOUND") {
      throw new NotFoundException("Claim not found");
    }
    throw new ConflictException("This claim has already been decided");
  }
}
