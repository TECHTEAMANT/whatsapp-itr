import { config } from '../config/env';
import { logger } from './logger';

const WEBHOOK_TIMEOUT_MS = 8000;

export const notifyBackend = async (path: string, body: Record<string, unknown>): Promise<void> => {
    if (!config.backendApiUrl || !config.backendCallbackToken) {
        return;
    }

    const url = `${config.backendApiUrl}${path.startsWith('/') ? path : `/${path}`}`;

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Internal-Service-Token': config.backendCallbackToken,
                'x-api-key': config.backendCallbackToken
            },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        clearTimeout(timeout);

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            logger.warn(`Backend webhook ${path} returned ${response.status}: ${text}`);
        }
    } catch (error: any) {
        logger.error(error, `Backend webhook failed for ${path}: ${error?.message || error}`);
    }
};

export const notifySessionStatus = async (payload: {
    userId: string;
    status: string;
    connectedNumber?: string | null;
    reason?: string;
}) => {
    await notifyBackend('/api/v1/whatsapp-qr/webhook/session-status', payload);
};

export const notifyMessageStatus = async (payload: {
    notificationId?: string;
    jobId?: string | number;
    userId?: string;
    targetNumber?: string;
    status: 'sent' | 'failed';
    error?: string;
    code?: string;
}) => {
    if (!payload.notificationId && !payload.jobId) {
        return;
    }
    await notifyBackend('/api/v1/whatsapp-qr/webhook/message-status', payload);
};
