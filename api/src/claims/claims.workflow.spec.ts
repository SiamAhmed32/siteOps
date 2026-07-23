/**
 * PostgreSQL-backed claims workflow tests (real DATABASE_URL).
 * Creates an isolated org/users/project per suite run and tears them down after.
 */
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { SequenceService } from '../common/sequence/sequence.service';
import { OutboxService } from '../outbox/outbox.service';
import { PrismaService } from '../prisma/prisma.service';
import { ClaimsService } from './claims.service';
import { CreateClaimDto } from './dto/create-claim.dto';

describe('ClaimsService workflow (postgres)', () => {
  jest.setTimeout(60_000);

  const prisma = new PrismaService();
  const claims = new ClaimsService(
    prisma,
    new SequenceService(prisma),
    new AuditService(prisma),
    new OutboxService(prisma),
  );

  let orgId: string;
  let otherOrgId: string;
  let aliceId: string;
  let carolId: string;
  let danId: string;
  let projectId: string;
  let otherProjectId: string;

  const smallLines: CreateClaimDto['lines'] = [
    { description: 'Unleaded', quantity: 3, unitPrice: '19.99', isFuel: true },
  ];
  const twoKeyLines: CreateClaimDto['lines'] = [
    { description: 'Bulk diesel', quantity: 50, unitPrice: '40.00', isFuel: true },
  ];
  // 50 × 40 = 2000 + 12.5% levy 250 = 2250 > 1000

  async function draftAndSubmit(
    submitterId: string,
    lines: CreateClaimDto['lines'],
  ) {
    const draft = await claims.create(
      {
        projectId,
        expenseDate: '2026-02-10',
        lines,
      },
      submitterId,
      orgId,
    );
    return claims.submit(orgId, submitterId, draft.id);
  }

  beforeAll(async () => {
    await prisma.$connect();

    const org = await prisma.organization.create({
      data: { slug: `wf-org-${Date.now()}`, name: 'Workflow Test Org' },
    });
    orgId = org.id;

    const otherOrg = await prisma.organization.create({
      data: { slug: `wf-other-${Date.now()}`, name: 'Other Org' },
    });
    otherOrgId = otherOrg.id;

    await prisma.surchargeRate.createMany({
      data: [
        { orgId, ratePercent: '12.50', effectiveFrom: new Date('2026-01-01') },
        { orgId: otherOrgId, ratePercent: '12.50', effectiveFrom: new Date('2026-01-01') },
      ],
    });

    const [alice, carol, dan] = await Promise.all([
      prisma.user.create({
        data: {
          orgId,
          email: `alice-wf-${Date.now()}@test.local`,
          name: 'Alice WF',
          permissions: ['claims.create'],
        },
      }),
      prisma.user.create({
        data: {
          orgId,
          email: `carol-wf-${Date.now()}@test.local`,
          name: 'Carol WF',
          permissions: ['claims.create', 'claims.approve'],
        },
      }),
      prisma.user.create({
        data: {
          orgId,
          email: `dan-wf-${Date.now()}@test.local`,
          name: 'Dan WF',
          permissions: ['claims.create', 'claims.approve'],
        },
      }),
    ]);
    aliceId = alice.id;
    carolId = carol.id;
    danId = dan.id;

    const project = await prisma.project.create({
      data: { orgId, code: 'WF-JOB', name: 'Workflow Job' },
    });
    projectId = project.id;

    const otherProject = await prisma.project.create({
      data: { orgId: otherOrgId, code: 'OTHER', name: 'Other Job' },
    });
    otherProjectId = otherProject.id;

    await prisma.numberSequence.create({
      data: { orgId, key: 'claim:26', nextValue: 1 },
    });
  });

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({ where: { orgId: { in: [orgId, otherOrgId] } } });
    await prisma.auditLog.deleteMany({ where: { orgId: { in: [orgId, otherOrgId] } } });
    await prisma.claim.deleteMany({ where: { orgId: { in: [orgId, otherOrgId] } } });
    await prisma.numberSequence.deleteMany({ where: { orgId: { in: [orgId, otherOrgId] } } });
    await prisma.project.deleteMany({ where: { id: { in: [projectId, otherProjectId] } } });
    await prisma.surchargeRate.deleteMany({ where: { orgId: { in: [orgId, otherOrgId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [aliceId, carolId, danId] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } });
    await prisma.$disconnect();
  });

  it('one-key approval from SUBMITTED → APPROVED with one audit + one outbox', async () => {
    const submitted = await draftAndSubmit(aliceId, smallLines);
    expect(submitted.total.toString()).toBe('67.47');

    const approved = await claims.approve(orgId, carolId, submitted.id);
    expect(approved.status).toBe('APPROVED');

    const audits = await prisma.auditLog.findMany({
      where: { orgId, entityType: 'claim', entityId: submitted.id, action: 'claim.approved' },
    });
    expect(audits).toHaveLength(1);

    const events = await prisma.outboxEvent.findMany({
      where: { orgId, type: 'claim.approved', payload: { path: ['claimId'], equals: submitted.id } },
    });
    expect(events).toHaveLength(1);
  });

  it('first key → PARTIALLY_APPROVED with no outbox; second different approver → APPROVED', async () => {
    const submitted = await draftAndSubmit(aliceId, twoKeyLines);
    expect(Number(submitted.total.toString())).toBeGreaterThan(1000);

    const partial = await claims.approve(orgId, carolId, submitted.id);
    expect(partial.status).toBe('PARTIALLY_APPROVED');
    expect(partial.firstApprovedById).toBe(carolId);

    const midEvents = await prisma.outboxEvent.findMany({
      where: { orgId, type: 'claim.approved', payload: { path: ['claimId'], equals: submitted.id } },
    });
    expect(midEvents).toHaveLength(0);

    const approved = await claims.approve(orgId, danId, submitted.id);
    expect(approved.status).toBe('APPROVED');
    expect(approved.approvedBy).toBe(danId);

    const events = await prisma.outboxEvent.findMany({
      where: { orgId, type: 'claim.approved', payload: { path: ['claimId'], equals: submitted.id } },
    });
    expect(events).toHaveLength(1);

    const audits = await prisma.auditLog.findMany({
      where: { orgId, entityType: 'claim', entityId: submitted.id, action: 'claim.approved' },
    });
    expect(audits).toHaveLength(1);
  });

  it('same approver cannot turn the second key', async () => {
    const submitted = await draftAndSubmit(aliceId, twoKeyLines);
    await claims.approve(orgId, carolId, submitted.id);
    await expect(claims.approve(orgId, carolId, submitted.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('submitter cannot approve or reject own claim', async () => {
    const submitted = await draftAndSubmit(aliceId, smallLines);
    await expect(claims.approve(orgId, aliceId, submitted.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(claims.reject(orgId, aliceId, submitted.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects from SUBMITTED and from PARTIALLY_APPROVED', async () => {
    const a = await draftAndSubmit(aliceId, smallLines);
    const rejected = await claims.reject(orgId, carolId, a.id);
    expect(rejected.status).toBe('REJECTED');

    const b = await draftAndSubmit(aliceId, twoKeyLines);
    await claims.approve(orgId, carolId, b.id);
    const rejectedPartial = await claims.reject(orgId, danId, b.id);
    expect(rejectedPartial.status).toBe('REJECTED');
  });

  it('approving an already rejected or approved claim fails with Conflict', async () => {
    const a = await draftAndSubmit(aliceId, smallLines);
    await claims.reject(orgId, carolId, a.id);
    await expect(claims.approve(orgId, carolId, a.id)).rejects.toBeInstanceOf(ConflictException);

    const b = await draftAndSubmit(aliceId, smallLines);
    await claims.approve(orgId, carolId, b.id);
    await expect(claims.approve(orgId, danId, b.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('two concurrent first approvals: exactly one wins', async () => {
    const submitted = await draftAndSubmit(aliceId, twoKeyLines);
    const results = await Promise.allSettled([
      claims.approve(orgId, carolId, submitted.id),
      claims.approve(orgId, danId, submitted.id),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((fulfilled[0] as PromiseFulfilledResult<{ status: string }>).value.status).toBe(
      'PARTIALLY_APPROVED',
    );
  });

  it('two concurrent second approvals: exactly one wins; one final outbox', async () => {
    const submitted = await draftAndSubmit(aliceId, twoKeyLines);
    await claims.approve(orgId, carolId, submitted.id);

    // Need a third approver for two concurrent second keys (Carol already used first key)
    const eve = await prisma.user.create({
      data: {
        orgId,
        email: `eve-wf-${Date.now()}@test.local`,
        name: 'Eve WF',
        permissions: ['claims.approve'],
      },
    });

    const results = await Promise.allSettled([
      claims.approve(orgId, danId, submitted.id),
      claims.approve(orgId, eve.id, submitted.id),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((fulfilled[0] as PromiseFulfilledResult<{ status: string }>).value.status).toBe(
      'APPROVED',
    );

    const events = await prisma.outboxEvent.findMany({
      where: { orgId, type: 'claim.approved', payload: { path: ['claimId'], equals: submitted.id } },
    });
    expect(events).toHaveLength(1);

    await prisma.user.delete({ where: { id: eve.id } });
  });

  it('concurrent approve vs reject: exactly one terminal state', async () => {
    const submitted = await draftAndSubmit(aliceId, smallLines);
    const results = await Promise.allSettled([
      claims.approve(orgId, carolId, submitted.id),
      claims.reject(orgId, danId, submitted.id),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    const status = (fulfilled[0] as PromiseFulfilledResult<{ status: string }>).value.status;
    expect(['APPROVED', 'REJECTED']).toContain(status);

    const claim = await prisma.claim.findUniqueOrThrow({ where: { id: submitted.id } });
    expect(claim.status).toBe(status);
  });

  it('failed decision writes no approval outbox; failed approve after reject stays clean', async () => {
    const submitted = await draftAndSubmit(aliceId, smallLines);
    await claims.reject(orgId, carolId, submitted.id);

    const beforeAudits = await prisma.auditLog.count({
      where: { orgId, entityId: submitted.id, action: 'claim.approved' },
    });
    const beforeOutbox = await prisma.outboxEvent.count({
      where: { orgId, type: 'claim.approved', payload: { path: ['claimId'], equals: submitted.id } },
    });

    await expect(claims.approve(orgId, danId, submitted.id)).rejects.toBeInstanceOf(
      ConflictException,
    );

    const afterAudits = await prisma.auditLog.count({
      where: { orgId, entityId: submitted.id, action: 'claim.approved' },
    });
    const afterOutbox = await prisma.outboxEvent.count({
      where: { orgId, type: 'claim.approved', payload: { path: ['claimId'], equals: submitted.id } },
    });
    expect(afterAudits).toBe(beforeAudits);
    expect(afterOutbox).toBe(beforeOutbox);
  });

  it('cross-organization access cannot see or approve another org claim', async () => {
    const submitted = await draftAndSubmit(aliceId, smallLines);
    await expect(claims.findOne(otherOrgId, submitted.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(claims.approve(otherOrgId, carolId, submitted.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('lists with status + fy filters and pagination meta', async () => {
    await draftAndSubmit(aliceId, smallLines);
    const page = await claims.list(orgId, { page: 1, pageSize: 10, status: 'SUBMITTED', fy: '26' });
    expect(page.meta.total).toBeGreaterThanOrEqual(1);
    expect(page.data.every((c) => c.status === 'SUBMITTED')).toBe(true);
  });

  it('imports LegacyPlant CSV best-effort per group', async () => {
    const csv = [
      'expense_date,description,quantity,unit_price,is_fuel,group',
      '2026-02-10,Diesel,3,"19.99",true,G1',
      '2026-02-10,Bad line,,,true,G1',
      '2026-02-11,Paint,2,"1,299.50",false,G2',
    ].join('\n');

    const result = await claims.importLegacyPlant(orgId, aliceId, {
      projectId,
      csv,
    });

    expect(result.created).toHaveLength(1);
    expect((result.created[0] as { status: string }).status).toBe('DRAFT');
    expect(Number((result.created[0] as { total: { toString(): string } }).total.toString())).toBe(
      2599,
    );
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].group).toBe('G1');
    expect(result.failed[0].rowNumbers.length).toBeGreaterThan(0);
  });

  it('import: an oversized line fails only its group with a curated reason', async () => {
    const csv = [
      'expense_date,description,quantity,unit_price,is_fuel,group',
      '2026-02-10,Good,2,"5.00",false,OK',
      '2026-02-10,Too big,1,"10000000000.00",false,BIG',
    ].join('\n');

    const result = await claims.importLegacyPlant(orgId, aliceId, { projectId, csv });

    expect(result.created).toHaveLength(1);
    const failed = result.failed.find((f) => f.group === 'BIG')!;
    expect(failed).toBeDefined();
    expect(failed.reasons.join(' ')).toMatch(/within range|maximum/i);
    // No partial claim persisted for the bad group.
    const persisted = await prisma.claim.findMany({
      where: { orgId, total: { gt: '9999999999.99' } },
    });
    expect(persisted).toHaveLength(0);
  });
});
