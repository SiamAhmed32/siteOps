import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  orgId: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Record a state-changing action. Pass `tx` to write inside the caller's transaction. */
  async record(
    entry: AuditEntry,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    return tx.auditLog.create({
      data: {
        orgId: entry.orgId,
        actorId: entry.actorId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        before: entry.before as any,
        after: entry.after as any,
      },
    });
  }

  async forEntity(orgId: string, entityType: string, entityId: string) {
    return this.prisma.auditLog.findMany({
      where: { orgId, entityType, entityId },
      orderBy: { createdAt: 'asc' },
    });
  }
}
