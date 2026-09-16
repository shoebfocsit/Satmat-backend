import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user;
    const userRoles: string[] = Array.isArray(user?.roles)
      ? user.roles
      : typeof user?.roles === 'string'
        ? (() => { try { const p = JSON.parse(user.roles); return Array.isArray(p) ? p : [user.roles]; } catch { return user.roles.includes(',') ? user.roles.split(',').map((s:string)=>s.trim()) : [user.roles]; } })()
        : [];
    if (!user || !userRoles.some((r: string) => requiredRoles.includes(r))) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'You do not have permission to perform this action',
      });
    }
    return true;
  }
}