import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorResponse: { code: string; message: string; details: Record<string, unknown> } = {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      details: {},
    };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'string') {
        errorResponse = { code: 'ERROR', message: res, details: {} };
      } else if (res && typeof res === 'object') {
        const r = res as any;
        if (r.code && r.message) {
          errorResponse = { code: r.code, message: r.message, details: r.details || {} };
        } else if (Array.isArray(r.message)) {
          errorResponse = {
            code: 'VALIDATION_ERROR',
            message: r.message.join('; '),
            details: { fields: r.message },
          };
        } else {
          errorResponse = { code: 'ERROR', message: r.message || r.error || 'Error', details: {} };
        }
      }
    } else if (exception instanceof Error) {
      // Prisma unique violations (concurrent same-phone registers, newsletter
      // re-subscribes, referral races) are client conflicts, never 500s.
      const prismaCode = (exception as any)?.code;
      if (prismaCode === 'P2002') {
        const target = (exception as any)?.meta?.target;
        const fields = Array.isArray(target) ? target.join(',') : String(target || '');
        status = HttpStatus.CONFLICT;
        errorResponse = fields.includes('phone')
          ? { code: 'PHONE_EXISTS', message: 'Phone number is already registered', details: {} }
          : fields.includes('email')
            ? { code: 'EMAIL_EXISTS', message: 'Email is already subscribed', details: {} }
            : { code: 'DUPLICATE', message: `Duplicate value for ${fields || 'unique field'}`, details: {} };
        this.logger.warn(`P2002 conflict on ${fields || 'unknown target'}: ${request.method} ${request.url}`);
      } else {
        errorResponse = { code: 'INTERNAL_ERROR', message: exception.message, details: {} };
        this.logger.error(exception.message, exception.stack);
      }
    }

    // Never expose stack traces or internal details in production.
    // requestId lets any future 500 be correlated with server logs.
    // Raw DB/driver messages (Prisma 25P02, connectors, SQL) must NEVER reach
    // clients — in production every 500 becomes a generic message while the
    // real error stays in server logs.
    const isProduction = process.env.NODE_ENV === 'production';
    if (isProduction && status === HttpStatus.INTERNAL_SERVER_ERROR) {
      errorResponse = {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong. Please try again.',
        details: {},
      };
    }
    const responseBody: Record<string, any> = {
      success: false,
      error: {
        code: errorResponse.code,
        message: errorResponse.message,
      },
    };
    const requestId = (request as any)?.requestId || (request as any)?.headers?.['x-request-id'];
    if (requestId) responseBody.error.requestId = requestId;

    if (!isProduction && errorResponse.details && Object.keys(errorResponse.details).length > 0) {
      responseBody.error.details = errorResponse.details;
    }

    response.status(status).json(responseBody);
  }
}