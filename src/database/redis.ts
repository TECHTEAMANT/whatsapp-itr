import Redis from 'ioredis';
import { config } from '../config/env';
import { logger } from '../utils/logger';

export const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    maxRetriesPerRequest: null,
});

redis.on('error', (err) => {
    logger.error(err, 'Redis connection error');
});

redis.on('connect', () => {
    logger.info('Connected to Redis');
});
