import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { Permissions } from '../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { ClaimsService } from './claims.service';
import { CreateClaimDto } from './dto/create-claim.dto';
import { EffectiveRateQueryDto } from './dto/effective-rate.dto';
import { ImportClaimsDto } from './dto/import-claims.dto';
import { ListClaimsDto } from './dto/list-claims.dto';

@Controller('claims')
@UseGuards(PermissionsGuard)
export class ClaimsController {
  constructor(private readonly claims: ClaimsService) {}

  @Post()
  @Permissions('claims.create')
  create(@Body() dto: CreateClaimDto, @Req() req: Request) {
    return this.claims.create(dto, (req as any).user.id, (req as any).orgId);
  }

  @Get()
  list(@Query() query: ListClaimsDto, @Req() req: Request) {
    return this.claims.list((req as any).orgId, query);
  }

  /** Static path before `:id` so "effective-rate" is not captured as an id. */
  @Get('effective-rate')
  effectiveRate(@Query() query: EffectiveRateQueryDto, @Req() req: Request) {
    return this.claims.effectiveLevyRate((req as any).orgId, query.date);
  }

  /** Static path before `:id` routes so "import" is not captured as an id. */
  @Post('import')
  @Permissions('claims.create')
  import(@Body() dto: ImportClaimsDto, @Req() req: Request) {
    return this.claims.importLegacyPlant((req as any).orgId, (req as any).user.id, dto);
  }

  @Post(':id/submit')
  @Permissions('claims.create')
  submit(@Param('id') id: string, @Req() req: Request) {
    return this.claims.submit((req as any).orgId, (req as any).user.id, id);
  }

  @Post(':id/approve')
  @Permissions('claims.approve')
  approve(@Param('id') id: string, @Req() req: Request) {
    return this.claims.approve((req as any).orgId, (req as any).user.id, id);
  }

  @Post(':id/reject')
  @Permissions('claims.approve')
  reject(@Param('id') id: string, @Req() req: Request) {
    return this.claims.reject((req as any).orgId, (req as any).user.id, id);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: Request) {
    return this.claims.findOne((req as any).orgId, id);
  }
}
