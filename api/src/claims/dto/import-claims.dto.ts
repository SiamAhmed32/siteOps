import { IsString, MinLength } from 'class-validator';

/**
 * LegacyPlant bulk import. CSV columns (header required):
 * expense_date, description, quantity, unit_price, is_fuel, group
 *
 * `projectId` is required separately — the export does not carry a cost code.
 * Imported claims are created as DRAFT for the acting submitter.
 */
export class ImportClaimsDto {
  @IsString()
  projectId: string;

  @IsString()
  @MinLength(1)
  csv: string;
}
