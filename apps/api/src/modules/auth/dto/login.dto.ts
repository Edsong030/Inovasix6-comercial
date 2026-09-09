import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Login input. The tenant is located by an explicit, non-secret company `slug`
 * combined with the email. tenantId is NEVER accepted from the client as an
 * authority — the slug only selects which tenant's user table to look in, and
 * the resulting tenantId is derived server-side.
 */
export class LoginDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  slug!: string;

  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password!: string;
}
