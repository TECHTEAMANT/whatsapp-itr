import { Request, Response, NextFunction } from 'express';
import { config } from '../../config/env';
import { logger } from '../../utils/logger';

export const apiKeyMiddleware = (req: Request, res: Response, next: NextFunction) => {
    const apiKey = req.headers['x-api-key'] || req.query.apiKey;

    if (!apiKey || apiKey !== config.apiKey) {
        logger.warn(`Unauthorized request attempt to ${req.originalUrl}. Received API Key: '${apiKey}', Expected: '${config.apiKey}'`);
        logger.warn(`Headers received: ${JSON.stringify(req.headers)}`);
        return res.status(403).json({ error: 'Forbidden: Invalid API Key' });
    }

    next();
};
