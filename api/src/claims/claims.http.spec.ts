/**
 * HTTP-level (Nest + Supertest) tests against real PostgreSQL.
 *
 * Service specs prove business/concurrency logic; this suite proves the wiring
 * that only exists over HTTP: fake-auth middleware, ValidationPipe, PermissionsGuard,
 * the success envelope (ResponseInterceptor) and the error envelope
 * (GlobalExceptionFilter). Runs with the normal `npm test` (needs DATABASE_URL).
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../app.module';
import { GlobalExceptionFilter } from '../common/filters/global-exception.filter';
import { PrismaService } from '../prisma/prisma.service';

describe('Claims HTTP (postgres)', () => {
  jest.setTimeout(60_000);

  let app: INestApplication;
  let prisma: PrismaService;

  let orgId: string;
  let otherOrgId: string;
  let creatorId: string; // claims.create
  let approverId: string; // claims.create + claims.approve
  let viewerId: string; // no permissions
  let otherUserId: string; // belongs to otherOrg
  let projectId: string;

  const auth = (userId: string, org: string) => ({
    'x-user-id': userId,
    'x-org-id': org,
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    // Mirror main.ts exactly so tests exercise the real request pipeline.
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();

    prisma = app.get(PrismaService);

    const suffix = Date.now();
    const org = await prisma.organization.create({
      data: { slug: `http-org-${suffix}`, name: 'HTTP Org' },
    });
    orgId = org.id;
    const otherOrg = await prisma.organization.create({
      data: { slug: `http-other-${suffix}`, name: 'HTTP Other' },
    });
    otherOrgId = otherOrg.id;

    await prisma.surchargeRate.create({
      data: { orgId, ratePercent: '12.50', effectiveFrom: new Date('2026-01-01') },
    });

    const [creator, approver, viewer, other] = await Promise.all([
      prisma.user.create({
        data: {
          orgId,
          email: `creator-${suffix}@t.local`,
          name: 'Creator',
          permissions: ['claims.create'],
        },
      }),
      prisma.user.create({
        data: {
          orgId,
          email: `approver-${suffix}@t.local`,
          name: 'Approver',
          permissions: ['claims.create', 'claims.approve'],
        },
      }),
      prisma.user.create({
        data: { orgId, email: `viewer-${suffix}@t.local`, name: 'Viewer', permissions: [] },
      }),
      prisma.user.create({
        data: {
          orgId: otherOrgId,
          email: `other-${suffix}@t.local`,
          name: 'Other',
          permissions: ['claims.create'],
        },
      }),
    ]);
    creatorId = creator.id;
    approverId = approver.id;
    viewerId = viewer.id;
    otherUserId = other.id;

    const project = await prisma.project.create({
      data: { orgId, code: 'HTTP-JOB', name: 'HTTP Job' },
    });
    projectId = project.id;

    await prisma.numberSequence.create({ data: { orgId, key: 'claim:26', nextValue: 1 } });
  });

  afterAll(async () => {
    const orgs = [orgId, otherOrgId];
    await prisma.outboxEvent.deleteMany({ where: { orgId: { in: orgs } } });
    await prisma.auditLog.deleteMany({ where: { orgId: { in: orgs } } });
    await prisma.claim.deleteMany({ where: { orgId: { in: orgs } } });
    await prisma.numberSequence.deleteMany({ where: { orgId: { in: orgs } } });
    await prisma.project.deleteMany({ where: { orgId: { in: orgs } } });
    await prisma.surchargeRate.deleteMany({ where: { orgId: { in: orgs } } });
    await prisma.user.deleteMany({
      where: { id: { in: [creatorId, approverId, viewerId, otherUserId] } },
    });
    await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
    await app.close();
  });

  const validBody = {
    projectId: '',
    expenseDate: '2026-02-10',
    lines: [{ description: 'Diesel', quantity: 3, unitPrice: '19.99', isFuel: true }],
  };

  it('401 envelope when auth headers are missing', async () => {
    const res = await request(app.getHttpServer()).get('/api/claims');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error).not.toHaveProperty('stack');
  });

  it('401 when the user id is unknown', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/claims')
      .set(auth('does-not-exist', orgId));
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('401 on cross-org header spoofing (user org ≠ x-org-id)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/claims')
      .set(auth(creatorId, otherOrgId));
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/organization/i);
  });

  it('400 envelope for invalid body (empty lines)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/claims')
      .set(auth(creatorId, orgId))
      .send({ ...validBody, projectId, lines: [] });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('BADREQUEST');
  });

  it('400 (not 500) for a negative unit price', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/claims')
      .set(auth(creatorId, orgId))
      .send({
        ...validBody,
        projectId,
        lines: [{ description: 'X', quantity: 1, unitPrice: '-5.00', isFuel: false }],
      });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('400 (not 500) when the total overflows the money column', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/claims')
      .set(auth(creatorId, orgId))
      .send({
        ...validBody,
        projectId,
        lines: [{ description: 'Huge', quantity: 1000000, unitPrice: '9999999999.99', isFuel: false }],
      });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.message).toMatch(/exceeds the maximum/i);
  });

  it('403 when the caller lacks claims.create', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/claims')
      .set(auth(viewerId, orgId))
      .send({ ...validBody, projectId });
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('403 when a creator without claims.approve tries to approve', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/claims/any-id/approve')
      .set(auth(creatorId, orgId));
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('201 success envelope creates a DRAFT with a reference', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/claims')
      .set(auth(creatorId, orgId))
      .send({ ...validBody, projectId });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('DRAFT');
    expect(res.body.data.reference).toBeTruthy();
    expect(res.body.timestamp).toBeTruthy();
  });

  it('200 list envelope carries pagination meta and transforms query', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/claims?page=1&pageSize=5&status=DRAFT&fy=26')
      .set(auth(creatorId, orgId));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta).toBeDefined();
    expect(res.body.data.every((c: { status: string }) => c.status === 'DRAFT')).toBe(true);
  });

  it('returns the effective levy rate for a date (same lookup create uses)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/claims/effective-rate?date=2026-02-10')
      .set(auth(creatorId, orgId));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.ratePercent).toBe('12.50');
    expect(res.body.data.effectiveFrom).toBe('2026-01-01');
  });

  it('effective-rate returns null before any rate is in force', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/claims/effective-rate?date=2000-01-01')
      .set(auth(creatorId, orgId));
    expect(res.status).toBe(200);
    expect(res.body.data.ratePercent).toBeNull();
  });

  it('404 envelope for an unknown claim id', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/claims/nope-nope')
      .set(auth(creatorId, orgId));
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toMatch(/NOT_?FOUND/);
  });

  it('imports a CSV over HTTP and returns curated group results', async () => {
    const csv = [
      'expense_date,description,quantity,unit_price,is_fuel,group',
      '2026-02-10,Diesel,2,"10.00",true,H1',
      '2026-02-11,Bad date,1,"5.00",true,H2',
    ]
      .join('\n')
      .replace('2026-02-11', '2026-02-30'); // force H2 invalid date

    const res = await request(app.getHttpServer())
      .post('/api/claims/import')
      .set(auth(approverId, orgId))
      .send({ projectId, csv });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.created).toHaveLength(1);
    expect(res.body.data.failed).toHaveLength(1);
    expect(res.body.data.failed[0].group).toBe('H2');
  });
});
