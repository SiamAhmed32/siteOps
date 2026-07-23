import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { Permissions } from '../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { ClaimsService } from './claims.service';
import { CreateClaimDto } from './dto/create-claim.dto';

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
  findAll(@Req() req: Request) {
    return this.claims.findAll((req as any).orgId);
  }

  @Post(':id/submit')
  @Permissions('claims.create')
  submit(@Param('id') id: string, @Req() req: Request) {
    return this.claims.submit((req as any).orgId, (req as any).user.id, id);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: Request) {
    return this.claims.findOne((req as any).orgId, id);
  }

  // TODO: approve / reject / import
}
