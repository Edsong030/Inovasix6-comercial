import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AppConfigService } from '../../config/app-config.service';
import { CurrentTenant } from '../../common/tenant/current-tenant.decorator';
import type { TenantContext } from '../../common/tenant/tenant-context';
import { AuthService, type AuthResult } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard, type RequestWithSession } from './jwt-auth.guard';

const REFRESH_COOKIE = 'inovasix_refresh';

/**
 * Auth endpoints. The refresh token travels ONLY in an HttpOnly cookie (never
 * readable by JS, never in localStorage). The access token is returned in the
 * body for the SPA to hold in memory. See docs/auth.md.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfigService,
  ) {}

  @Post('login')
  @HttpCode(200)
  // Stricter than the global limiter: brute-force resistance on credentials.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(dto.slug, dto.email, dto.password, this.meta(req));
    this.setRefreshCookie(res, result);
    return this.publicTokens(result);
  }

  @Post('refresh')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = this.readRefreshCookie(req);
    if (!raw) throw new UnauthorizedException('Credenciais inválidas.');
    const result = await this.auth.refresh(raw, this.meta(req));
    this.setRefreshCookie(res, result);
    return this.publicTokens(result);
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(JwtAuthGuard)
  async logout(
    @CurrentTenant() ctx: TenantContext,
    @Req() req: RequestWithSession,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    if (req.sessionId) {
      await this.auth.logout(ctx.tenantId, ctx.userId, req.sessionId);
    }
    this.clearRefreshCookie(res);
  }

  @Post('logout-all')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async logoutAll(
    @CurrentTenant() ctx: TenantContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const revoked = await this.auth.logoutAll(ctx.tenantId, ctx.userId);
    this.clearRefreshCookie(res);
    return { revoked };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentTenant() ctx: TenantContext) {
    return {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      roles: ctx.roleCodes,
    };
  }

  // -- helpers ---------------------------------------------------------------

  private meta(req: Request) {
    const forwarded = req.headers['x-forwarded-for'];
    const ip =
      (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]?.trim()) ??
      req.socket.remoteAddress ??
      undefined;
    const ua = req.headers['user-agent'];
    return { ip, userAgent: Array.isArray(ua) ? ua[0] : ua };
  }

  private publicTokens(result: AuthResult) {
    // Refresh token is intentionally NOT in the body — it is HttpOnly-cookie only.
    return {
      accessToken: result.accessToken,
      expiresIn: result.accessTokenExpiresInSec,
      tokenType: 'Bearer',
    };
  }

  private setRefreshCookie(res: Response, result: AuthResult): void {
    res.cookie(REFRESH_COOKIE, result.refreshToken, {
      httpOnly: true,
      secure: this.config.isProduction,
      sameSite: 'strict',
      path: '/api/auth',
      maxAge: result.refreshTokenExpiresInSec * 1000,
    });
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      secure: this.config.isProduction,
      sameSite: 'strict',
      path: '/api/auth',
    });
  }

  private readRefreshCookie(req: Request): string | undefined {
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
    return cookies?.[REFRESH_COOKIE];
  }
}
