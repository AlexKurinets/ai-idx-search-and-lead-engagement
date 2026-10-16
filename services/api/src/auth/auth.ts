import {
  Body,
  CanActivate,
  Controller,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  HttpCode,
  Injectable,
  NotFoundException,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config';
import { parseBody } from '../common/validate';
import { TenantsService } from '../search/tenants.service';

export interface Principal {
  sub: string;
  role: 'office_admin' | 'platform_admin';
  tenant_id: string | null;
  tenant_slug: string | null;
}

/**
 * Verifies bearer tokens. In production the verifier checks identity-provider tokens
 * against its JWKS; here a dev issuer signs HS256 tokens with the same claims, and is
 * only mounted when AUTH_MODE=dev.
 */
export function verifyToken(header: string | undefined): Principal {
  if (!header?.startsWith('Bearer ')) throw new UnauthorizedException();
  try {
    return jwt.verify(header.slice(7), config.jwtSecret, { algorithms: ['HS256'], issuer: 'idx-dev' }) as Principal;
  } catch {
    throw new UnauthorizedException();
  }
}

@Injectable()
export class OfficeGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const p = verifyToken(req.headers.authorization);
    if (!p.tenant_id) throw new ForbiddenException('office token required');
    req.principal = p;
    return true;
  }
}

@Injectable()
export class PlatformGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const p = verifyToken(req.headers.authorization);
    if (p.role !== 'platform_admin') throw new ForbiddenException('platform role required');
    req.principal = p;
    return true;
  }
}

export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => {
  return ctx.switchToHttp().getRequest().principal;
});

const DevTokenRequest = z.object({ tenant_slug: z.string().optional(), platform: z.boolean().optional() });

@Controller('v1/auth')
export class DevAuthController {
  constructor(private readonly tenants: TenantsService) {}

  @Post('dev-token')
  @HttpCode(200)
  async devToken(@Body() body: unknown) {
    if (config.authMode !== 'dev') throw new NotFoundException();
    const b = parseBody(DevTokenRequest, body);
    let claims: Principal;
    if (b.platform) {
      claims = { sub: 'platform-admin', role: 'platform_admin', tenant_id: null, tenant_slug: null };
    } else {
      const t = await this.tenants.bySlug(b.tenant_slug ?? '');
      claims = { sub: `office-admin:${t.slug}`, role: 'office_admin', tenant_id: t.id, tenant_slug: t.slug };
    }
    return { token: jwt.sign(claims, config.jwtSecret, { algorithm: 'HS256', expiresIn: '12h', issuer: 'idx-dev' }) };
  }
}
