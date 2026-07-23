import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { AuditService } from '../audit/audit.service';
import { SequenceService } from '../common/sequence/sequence.service';
import { PrismaService } from '../prisma/prisma.service';
import { computeClaimTotals } from './claim-totals';
import { CreateClaimDto } from './dto/create-claim.dto';
import { claimSequenceKey, financialYearCode } from './financial-year';

@Injectable()
export class ClaimsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sequence: SequenceService,
    private readonly audit: AuditService,
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
          levyAmount: new Decimal(totals.levyAmount.toFixed(2)),
          total: new Decimal(totals.total.toFixed(2)),
          lines: {
            create: dto.lines.map((l) => ({
              description: l.description,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              isFuel: l.isFuel,
            })),
          },
        },
        include: { lines: true, project: { select: { code: true, name: true } } },
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
        tx as any,
      );

      return claim;
    });
  }

  async findAll(orgId: string) {
    return this.prisma.claim.findMany({
      where: { orgId },
      include: { lines: true, project: { select: { code: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(orgId: string, id: string) {
    const claim = await this.prisma.claim.findFirst({
      where: { id, orgId },
      include: { lines: true, project: { select: { code: true, name: true } } },
    });
    if (!claim) {
      throw new NotFoundException(`Claim ${id} not found`);
    }
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
