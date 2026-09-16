import { ForbiddenException } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

describe('AllExceptionsFilter', () => {
  const prevEnv = process.env.NODE_ENV;

  const hostFor = () => {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    return {
      host: {
        switchToHttp: () => ({
          getResponse: () => ({ status }),
          getRequest: () => ({ method: 'POST', url: '/api/v1/bids', headers: {} }),
        }),
      } as any,
      json,
    };
  };

  afterEach(() => {
    process.env.NODE_ENV = prevEnv;
  });

  it('sanitizes raw DB errors to a generic message in production', () => {
    process.env.NODE_ENV = 'production';
    const { host, json } = hostFor();
    new AllExceptionsFilter().catch(
      new Error(
        'Invalid `prisma.user.findUnique()` invocation: ConnectorError { kind: QueryError(PostgresError { code: "25P02" }) }',
      ),
      host,
    );
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong. Please try again.',
      },
    });
    const body = json.mock.calls[0][0].error;
    expect(JSON.stringify(body)).not.toContain('25P02');
    expect(JSON.stringify(body)).not.toContain('prisma');
  });

  it('keeps coded client errors intact in production', () => {
    process.env.NODE_ENV = 'production';
    const { host, json } = hostFor();
    new AllExceptionsFilter().catch(
      new ForbiddenException({ code: 'MARKET_CLOSED', message: 'Bidding is closed for X' }),
      host,
    );
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'MARKET_CLOSED', message: 'Bidding is closed for X' },
    });
  });

  it('preserves detail in non-production for debugging', () => {
    process.env.NODE_ENV = 'development';
    const { host, json } = hostFor();
    new AllExceptionsFilter().catch(new Error('boom detail'), host);
    expect(json.mock.calls[0][0].error.message).toBe('boom detail');
  });
});
