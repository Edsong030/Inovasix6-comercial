import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/** Move a lead to another stage of the same tenant's pipeline. */
export class MoveLeadDto {
  @ApiProperty({ description: 'Etapa de destino (mesmo tenant/pipeline).' })
  @IsUUID()
  stageId!: string;
}
