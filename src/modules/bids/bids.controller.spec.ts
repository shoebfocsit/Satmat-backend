import { BidsController } from './bids.controller';

describe('BidsController idempotency gate', () => {
  const service = {
    placeBid: jest.fn(),
    placeBulkBid: jest.fn(),
    cancelBid: jest.fn(),
  };
  const controller = new BidsController(service as any);

  const dto = { marketId: 'diamond', gameType: 'JODI', number: '47', amount: 5000 } as any;
  const bulk = {
    marketId: 'diamond',
    gameType: 'ANK',
    round: 'CLOSE',
    items: [{ number: '5', amount: 2000 }],
  } as any;

  beforeEach(() => jest.clearAllMocks());

  const codeOf = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      fail('should throw');
    } catch (e) {
      return (e as any)?.response?.code ?? (e as any)?.response;
    }
  };

  it('rejects placement/cancel without an Idempotency-Key', async () => {
    expect(await codeOf(() => controller.place('u1', dto, undefined))).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(await codeOf(() => controller.bulk('u1', bulk, ''))).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(await codeOf(() => controller.bulk('u1', bulk, '   '))).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(await codeOf(() => controller.cancel('u1', 'bid-1', undefined))).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(service.placeBid).not.toHaveBeenCalled();
    expect(service.placeBulkBid).not.toHaveBeenCalled();
    expect(service.cancelBid).not.toHaveBeenCalled();
  });

  it('rejects absurdly long keys', async () => {
    expect(await codeOf(() => controller.place('u1', dto, 'x'.repeat(129)))).toBe(
      'IDEMPOTENCY_KEY_REQUIRED',
    );
    expect(service.placeBid).not.toHaveBeenCalled();
  });

  it('forwards a valid key (trimmed) to the service', async () => {
    service.placeBid.mockResolvedValue({ success: true });
    service.placeBulkBid.mockResolvedValue({ success: true });
    service.cancelBid.mockResolvedValue({ success: true });
    await controller.place('u1', dto, '  k-1  ');
    await controller.bulk('u1', bulk, 'k-2');
    await controller.cancel('u1', 'bid-1', 'k-3');
    expect(service.placeBid).toHaveBeenCalledWith('u1', dto, 'k-1');
    expect(service.placeBulkBid).toHaveBeenCalledWith('u1', bulk, 'k-2');
    expect(service.cancelBid).toHaveBeenCalledWith('u1', 'bid-1', 'k-3');
  });
});
