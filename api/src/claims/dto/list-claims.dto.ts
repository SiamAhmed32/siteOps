import { IsIn, IsOptional, Matches } from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class ListClaimsDto extends PaginationDto {
  @IsOptional()
  @IsIn(['DRAFT', 'SUBMITTED', 'PARTIALLY_APPROVED', 'APPROVED', 'REJECTED'])
  status?: string;

  /** Two-digit FY code from expense date, e.g. "26" for FY26. */
  @IsOptional()
  @Matches(/^\d{2}$/, { message: 'fy must be a two-digit code, e.g. 26' })
  fy?: string;
}
