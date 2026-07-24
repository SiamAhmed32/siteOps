import { IsDateString } from 'class-validator';

/**
 * Query for the effective levy rate on a given date. Powers the new-claim
 * preview so the client never has to hard-code the rate schedule — it reads the
 * same effective-dated SurchargeRate the create path uses.
 */
export class EffectiveRateQueryDto {
  @IsDateString()
  date: string;
}
