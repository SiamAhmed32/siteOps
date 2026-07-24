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
import { paginationMeta } from '../common/dto/pagination.dto';
import { requiresTwoKeys } from './claim-lifecycle';
import { computeClaimTotals } from './claim-totals';
import { CreateClaimDto } from './dto/create-claim.dto';
import { ImportClaimsDto } from './dto/import-claims.dto';
import { ListClaimsDto } from './dto/list-claims.dto';
import {
  claimSequenceKey,
  financialYearCode,
  financialYearDateRange,
} from './financial-year';
import { parseLegacyPlantCsv } from './legacy-plant-csv';

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
    let totals;
    try {
      totals = computeClaimTotals(
        dto.lines.map((l) => ({
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          isFuel: l.isFuel,
        })),
        rate,
      );
    } catch (err) {
      // Amount/overflow problems are client errors (400), never internal 500s.
      throw new BadRequestException(
        err instanceof Error ? err.message : 'Invalid claim amounts',
      );
    }

    let reference = '';
    try {
      return await this.prisma.$transaction(async (tx) => {
        const seq = await this.sequence.next(tx, orgId, claimSequenceKey(expenseDate));
        const fy = financialYearCode(expenseDate);
        reference = `EXP ${fy}-${String(seq).padStart(4, '0')}`;

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
    } catch (err) {
      // Claim references are auto-generated and unique per org. A collision on
      // the unique constraint means that reference is already taken; surface a
      // clear, non-technical message instead of leaking Prisma internals.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          `A claim with reference ${reference} already exists.`,
        );
      }
      throw err;
    }
  }

  async list(orgId: string, query: ListClaimsDto) {
    const where: Prisma.ClaimWhereInput = {
      orgId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.fy
        ? (() => {
            const { gte, lt } = financialYearDateRange(query.fy);
            return { expenseDate: { gte, lt } };
          })()
        : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.claim.findMany({
        where,
        include: claimInclude,
        orderBy: [{ expenseDate: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.claim.count({ where }),
    ]);

    return { data, meta: paginationMeta(total, query) };
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
   * LegacyPlant CSV import — best-effort per group/claim.
   * Valid groups become DRAFT claims; invalid groups are reported with row numbers.
   * A group with any bad line is rejected whole (no partial claim).
   */
  async importLegacyPlant(orgId: string, actorId: string, dto: ImportClaimsDto) {
    const project = await this.prisma.project.findFirst({
      where: { id: dto.projectId, orgId },
    });
    if (!project) throw new BadRequestException('Unknown project');

    let groups;
    try {
      groups = parseLegacyPlantCsv(dto.csv);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : 'Invalid CSV');
    }

    const created: unknown[] = [];
    const failed: {
      group: string;
      rowNumbers: number[];
      reasons: string[];
    }[] = [];

    for (const g of groups) {
      if (g.rows.length > 0) {
        const dates = new Set(g.rows.map((r) => r.expenseDate.slice(0, 10)));
        if (dates.size > 1) {
          g.errors.push({
            rowNumber: g.rows[0].rowNumber,
            reason: 'all rows in a group must share the same expense_date',
          });
        }
      }

      if (g.errors.length > 0 || g.rows.length === 0) {
        const rowNumbers = [
          ...new Set([
            ...g.errors.map((e) => e.rowNumber),
            ...g.rows.map((r) => r.rowNumber),
          ]),
        ].sort((a, b) => a - b);
        const reasons: string[] = [];
        for (const e of g.errors) {
          const msg = `row ${e.rowNumber}: ${e.reason}`;
          if (!reasons.includes(msg)) reasons.push(msg);
        }
        if (g.rows.length === 0 && g.errors.length === 0) {
          reasons.push('group has no rows');
        }
        failed.push({ group: g.group || '(empty)', rowNumbers, reasons });
        continue;
      }

      try {
        const claim = await this.create(
          {
            projectId: dto.projectId,
            expenseDate: g.rows[0].expenseDate,
            lines: g.rows.map((r) => ({
              description: r.description,
              quantity: r.quantity,
              unitPrice: r.unitPrice,
              isFuel: r.isFuel,
            })),
          },
          actorId,
          orgId,
        );
        created.push(claim);
      } catch (err) {
        // Surface only curated business errors; never leak Prisma/internal detail.
        const message =
          err instanceof BadRequestException || err instanceof ConflictException
            ? err.message
            : 'Failed to create claim';
        failed.push({
          group: g.group,
          rowNumbers: g.rows.map((r) => r.rowNumber),
          reasons: [message],
        });
      }
    }

    return { created, failed };
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
   * Levy rate in force for the org on a date (effective-dated), or null if none.
   * Single source of truth for both create and the preview endpoint.
   */
  private async lookupLevyRate(orgId: string, on: Date) {
    return this.prisma.surchargeRate.findFirst({
      where: { orgId, effectiveFrom: { lte: on } },
      orderBy: { effectiveFrom: 'desc' },
    });
  }

  /**
   * Levy rate in force for the org on the expense date (effective-dated).
   * Returns a decimal string for the calculator; throws if none applies.
   */
  private async findEffectiveLevyRate(orgId: string, expenseDate: Date): Promise<string> {
    const rate = await this.lookupLevyRate(orgId, expenseDate);
    if (!rate) {
      throw new BadRequestException('No levy rate in force for this expense date');
    }
    return rate.ratePercent.toFixed(2);
  }

  /**
   * Effective levy rate for a date — powers the new-claim preview so the client
   * reads the same rate the create path will apply (no hard-coded schedule).
   * Returns `ratePercent: null` when no rate is in force yet (client shows a hint).
   */
  async effectiveLevyRate(orgId: string, date: string) {
    const on = new Date(date);
    if (Number.isNaN(on.getTime())) {
      throw new BadRequestException('date must be a valid date');
    }
    const rate = await this.lookupLevyRate(orgId, on);
    return {
      date,
      ratePercent: rate ? rate.ratePercent.toFixed(2) : null,
      effectiveFrom: rate ? rate.effectiveFrom.toISOString().slice(0, 10) : null,
    };
  }
}
