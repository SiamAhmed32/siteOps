import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

// Non-negative, at most 10 integer digits + 2 decimals — fits DB Decimal(12,2).
const MONEY_RE = /^\d{1,10}(\.\d{1,2})?$/;

export class ClaimLineDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 200)
  description: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  quantity: number;

  /** Money as a decimal string (e.g. "19.99"). Numbers are stringified for legacy clients. */
  @Transform(({ value }) => (value == null ? value : String(value).trim()))
  @Matches(MONEY_RE, {
    message: 'unitPrice must be a non-negative amount with at most 2 decimal places',
  })
  unitPrice: string;

  @Transform(({ value }) => value ?? false)
  @IsBoolean()
  isFuel: boolean = false;
}

export class CreateClaimDto {
  @IsString()
  projectId: string;

  @IsDateString()
  expenseDate: string;

  // status is intentionally absent — create always produces DRAFT

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ClaimLineDto)
  lines: ClaimLineDto[];
}
