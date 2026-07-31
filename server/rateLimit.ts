// Minimal fixed-window in-memory rate limiter for the public compile endpoints.
// No external dependency; suitable for a single-instance deployment.

import type { Request, Response, NextFunction } from 'express';

interface Bucket {
  count: number;
  windowStart: number;
}

export function rateLimit(options: { windowMs: number; max: number; name: string }) {
  const buckets = new Map<string, Bucket>();

  // periodic cleanup so the map cannot grow unbounded
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (now - bucket.windowStart > options.windowMs * 2) buckets.delete(key);
    }
  }, options.windowMs);
  sweep.unref?.();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStart >= options.windowMs) {
      bucket = { count: 0, windowStart: now };
      buckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > options.max) {
      const retryAfterSec = Math.ceil((bucket.windowStart + options.windowMs - now) / 1000);
      res.setHeader('Retry-After', String(Math.max(1, retryAfterSec)));
      res.status(429).json({
        success: false,
        error: `Too many ${options.name} requests — please retry in about ${Math.max(1, retryAfterSec)} seconds.`,
        errorCode: 'RATE_LIMITED',
      });
      return;
    }
    next();
  };
}
