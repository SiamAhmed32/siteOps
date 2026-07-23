import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { SequenceService } from '../common/sequence/sequence.service';
import { OutboxService } from '../outbox/outbox.service';
import { PrismaService } from '../prisma/prisma.service';
import { requiresTwoKeys } from './claim-lifecycle';
import { computeClaimTotals } from './claim-totals';
import { CreateClaimDto } from './dto/create-claim.dto';
import { claimSequenceKey, financialYearCode } from './financial-year';

const claimInclude = {
  lines: true,
  project: { select: { code: true, name: true } },
} as const;

@Injectable()
export class ClaimsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sequence: SequenceService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async create(dto: CreateClaimDto, userId: string, orgId: string) {
    const expenseDate = new Date(dto.expenseDate);

    const project = await this.prisma.project.findFirst({
      where: { id: dto.projectId, orgId },
    });
    if (!project) {
      throw new BadRequestException('Unknown project');
    }

    const rate = await this.findEffectiveLevyRate(orgId, expenseDate);
    const totals = computeClaimTotals(
      dto.lines.map((l) => ({
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        isFuel: l.isFuel,
      })),
      rate,
    );

    return this.prisma.$transaction(async (tx) => {
      const seq = await this.sequence.next(tx, orgId, claimSequenceKey(expenseDate));
      const fy = financialYearCode(expenseDate);
      const reference = `EXP ${fy}-${String(seq).padStart(4, '0')}`;

      const claim = await tx.claim.create({
        data: {
          orgId,
          projectId: dto.projectId,
          submitterId: userId,
          reference,
          status: 'DRAFT',
          expenseDate,
          levyRatePercent: rate,
          levyAmount: totals.levyAmount.toFixed(2),
          total: totals.total.toFixed(2),
          lines: {
            create: dto.lines.map((l) => ({
              description: l.description,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              isFuel: l.isFuel,
            })),
          },
        },
        include: claimInclude,
      });

      await this.audit.record(
        {
          orgId,
          actorId: userId,
          action: 'claim.created',
          entityType: 'claim',
          entityId: claim.id,
          after: {
            reference: claim.reference,
            status: claim.status,
            total: claim.total,
            levyRatePercent: claim.levyRatePercent,
            levyAmount: claim.levyAmount,
          },
        },
        tx,
      );

      return claim;
    });
  }

  async findAll(orgId: string) {
    return this.prisma.claim.findMany({
      where: { orgId },
      include: claimInclude,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(orgId: string, id: string) {
    const claim = await this.prisma.claim.findFirst({
      where: { id, orgId },
      include: claimInclude,
    });
    if (!claim) {
      throw new NotFoundException(`Claim ${id} not found`);
    }
    const history = await this.audit.forEntity(orgId, 'claim', id);
    return { ...claim, history };
  }

  /**
   * Lodgment: DRAFT → SUBMITTED.
   * Only the claim's submitter may lodge. Totals / levyRatePercent already stored
   * at create are left untouched — we never re-read live SurchargeRate rows here.
   * Status + submitter checks live in the UPDATE WHERE (dockets-style) so concurrent
   * submits cannot both succeed.
   */
  async submit(orgId: string, actorId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.claim.updateMany({
        where: { id, orgId, status: 'DRAFT', submitterId: actorId },
        data: { status: 'SUBMITTED' },
      });

      if (updated.count === 0) {
        const existing = await tx.claim.findFirst({
          where: { id, orgId },
          select: { status: true, submitterId: true },
        });
        if (!existing) throw new NotFoundException('Claim not found');
        if (existing.submitterId !== actorId) {
          throw new ForbiddenException('Only the claim submitter can lodge this claim');
        }
        throw new ConflictException(`Claim is ${existing.status}, expected DRAFT`);
      }

      const claim = await tx.claim.findFirstOrThrow({
        where: { id, orgId },
        include: claimInclude,
      });

      await this.audit.record(
        {
          orgId,
          actorId,
          action: 'claim.submitted',
          entityType: 'claim',
          entityId: id,
          before: { status: 'DRAFT' },
          after: {
            status: 'SUBMITTED',
            total: claim.total,
            levyRatePercent: claim.levyRatePercent,
            levyAmount: claim.levyAmount,
          },
        },
        tx,
      );

      return claim;
    });
  }

  /**
   * Approve — one-key or two-key depending on ex-GST total.
   * No self-dealing. Concurrent approvers: status (+ first key actor) checked in UPDATE WHERE.
   * Final approval enqueues outbox `claim.approved` (like docket.confirmed).
   */
  async approve(orgId: string, actorId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.claim.findFirst({
        where: { id, orgId },
        select: {
          status: true,
          submitterId: true,
          total: true,
          firstApprovedById: true,
          reference: true,
        },
      });
      if (!existing) throw new NotFoundException('Claim not found');
      if (existing.submitterId === actorId) {
        throw new ForbiddenException('Cannot approve your own claim');
      }

      const now = new Date();
      const twoKey = requiresTwoKeys(existing.total);

      if (existing.status === 'SUBMITTED') {
        if (twoKey) {
          const updated = await tx.claim.updateMany({
            where: { id, orgId, status: 'SUBMITTED' },
            data: {
              status: 'PARTIALLY_APPROVED',
              firstApprovedById: actorId,
              firstApprovedAt: now,
            },
          });
          if (updated.count === 0) {
            throw new ConflictException('Claim is no longer SUBMITTED');
          }
          const claim = await tx.claim.findFirstOrThrow({ where: { id, orgId }, include: claimInclude });
          await this.audit.record(
            {
              orgId,
              actorId,
              action: 'claim.partially_approved',
              entityType: 'claim',
              entityId: id,
              before: { status: 'SUBMITTED' },
              after: { status: 'PARTIALLY_APPROVED', firstApprovedById: actorId },
            },
            tx,
          );
          return claim;
        }

        const updated = await tx.claim.updateMany({
          where: { id, orgId, status: 'SUBMITTED' },
          data: {
            status: 'APPROVED',
            approvedBy: actorId,
            approvedAt: now,
          },
        });
        if (updated.count === 0) {
          throw new ConflictException('Claim is no longer SUBMITTED');
        }
        return this.finalizeApproval(tx, orgId, actorId, id, 'SUBMITTED');
      }

      if (existing.status === 'PARTIALLY_APPROVED') {
        if (!twoKey) {
          throw new ConflictException('Claim does not require a second key');
        }
        if (existing.firstApprovedById === actorId) {
          throw new ForbiddenException('Second key must be a different approver');
        }
        const updated = await tx.claim.updateMany({
          where: {
            id,
            orgId,
            status: 'PARTIALLY_APPROVED',
            firstApprovedById: { not: actorId },
          },
          data: {
            status: 'APPROVED',
            approvedBy: actorId,
            approvedAt: now,
          },
        });
        if (updated.count === 0) {
          const again = await tx.claim.findFirst({
            where: { id, orgId },
            select: { status: true, firstApprovedById: true },
          });
          if (again?.firstApprovedById === actorId) {
            throw new ForbiddenException('Second key must be a different approver');
          }
          throw new ConflictException(`Claim is ${again?.status}, expected PARTIALLY_APPROVED`);
        }
        return this.finalizeApproval(tx, orgId, actorId, id, 'PARTIALLY_APPROVED');
      }

      throw new ConflictException(`Claim is ${existing.status}, expected SUBMITTED or PARTIALLY_APPROVED`);
    });
  }

  /**
   * Reject from SUBMITTED or PARTIALLY_APPROVED. No self-dealing. Final — no reopen here
   * (rejected-claims policy documented in DECISIONS.md).
   */
  async reject(orgId: string, actorId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.claim.findFirst({
        where: { id, orgId },
        select: { status: true, submitterId: true },
      });
      if (!existing) throw new NotFoundException('Claim not found');
      if (existing.submitterId === actorId) {
        throw new ForbiddenException('Cannot reject your own claim');
      }
      if (existing.status !== 'SUBMITTED' && existing.status !== 'PARTIALLY_APPROVED') {
        throw new ConflictException(
          `Claim is ${existing.status}, expected SUBMITTED or PARTIALLY_APPROVED`,
        );
      }

      const beforeStatus = existing.status;
      const now = new Date();
      const updated = await tx.claim.updateMany({
        where: {
          id,
          orgId,
          status: { in: ['SUBMITTED', 'PARTIALLY_APPROVED'] },
        },
        data: {
          status: 'REJECTED',
          rejectedById: actorId,
          rejectedAt: now,
        },
      });
      if (updated.count === 0) {
        const again = await tx.claim.findFirst({ where: { id, orgId }, select: { status: true } });
        throw new ConflictException(`Claim is ${again?.status}, expected SUBMITTED or PARTIALLY_APPROVED`);
      }

      const claim = await tx.claim.findFirstOrThrow({ where: { id, orgId }, include: claimInclude });
      await this.audit.record(
        {
          orgId,
          actorId,
          action: 'claim.rejected',
          entityType: 'claim',
          entityId: id,
          before: { status: beforeStatus },
          after: { status: 'REJECTED', rejectedById: actorId },
        },
        tx,
      );
      return claim;
    });
  }

  private async finalizeApproval(
    tx: Prisma.TransactionClient,
    orgId: string,
    actorId: string,
    id: string,
    fromStatus: string,
  ) {
    const claim = await tx.claim.findFirstOrThrow({ where: { id, orgId }, include: claimInclude });
    await this.audit.record(
      {
        orgId,
        actorId,
        action: 'claim.approved',
        entityType: 'claim',
        entityId: id,
        before: { status: fromStatus },
        after: { status: 'APPROVED', approvedBy: actorId },
      },
      tx,
    );
    await this.outbox.enqueue(tx, {
      orgId,
      type: 'claim.approved',
      payload: {
        claimId: id,
        reference: claim.reference,
        total: claim.total.toString(),
        projectId: claim.projectId,
      },
    });
    return claim;
  }

  /**
   * Levy rate in force for the org on the expense date (effective-dated).
   * Returns a decimal string for the calculator.
   */
  private async findEffectiveLevyRate(orgId: string, expenseDate: Date): Promise<string> {
    const rate = await this.prisma.surchargeRate.findFirst({
      where: { orgId, effectiveFrom: { lte: expenseDate } },
      orderBy: { effectiveFrom: 'desc' },
    });
    if (!rate) {
      throw new BadRequestException('No levy rate in force for this expense date');
    }
    return rate.ratePercent.toFixed(2);
  }
}
