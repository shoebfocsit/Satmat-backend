export interface CacheStore {
  set(key: string, value: any, ttlMs?: number): Promise<void>;
  get<T = any>(key: string): Promise<T | undefined>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  // Optional sweep for memory stores
  sweep?(): void;
}
