import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsDecimal,
  IsInt,
  IsString,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';

export class ClaimLineDto {
  @IsString()
  @Length(1, 200)
  description: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity: number;

  /** Money as a decimal string (e.g. "19.99"). Numbers are stringified for legacy clients. */
  @Transform(({ value }) => (value == null ? value : String(value)))
  @IsDecimal({ decimal_digits: '0,2' })
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
  @ValidateNested({ each: true })
  @Type(() => ClaimLineDto)
  lines: ClaimLineDto[];
}
