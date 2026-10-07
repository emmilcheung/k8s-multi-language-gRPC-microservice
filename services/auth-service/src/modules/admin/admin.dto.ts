import { Transform } from 'class-transformer';
import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { PLATFORM_ROLES, type PlatformRole } from './platform-roles';
import type { RoleAction } from './role-change';

export class ChangeRoleDto {
  @IsIn(PLATFORM_ROLES, {
    message: `role must be one of: ${PLATFORM_ROLES.join(', ')}`,
  })
  role!: PlatformRole;

  @IsIn(['grant', 'remove'], { message: 'action must be grant or remove' })
  action!: RoleAction;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty({ message: 'reason is required' })
  @MaxLength(500)
  reason!: string;
}
