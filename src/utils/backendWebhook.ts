import { config } from '../config/env';
import { logger } from './logger';

const WEBHOOK_TIMEOUT_MS = 8000;

/**
 * Resolves the target backend API URL based on request Origin/Referer header or explicit URL.
 * - app-dev.accountsntax.com -> Dev Backend
 * - app.accountsntax.com -> Prod Backend
 * - Fallback -> Default configured backend API URL
 */
export const resolveBackendUrl = (originOrReferer?: string): string => {
    const origin = (originOrReferer || '').toLowerCase();

    if (origin.includes('app-dev.accountsntax.com')) {
        return config.backend.devUrl || config.backend.defaultUrl;
    }

    if (origin.includes('app.accountsntax.com')) {
        return config.backend.prodUrl || config.backend.defaultUrl;
    }

    return config.backend.defaultUrl || config.backendApiUrl || config.backend.devUrl || config.backend.prodUrl;
};

export const notifyBackend = async (
    path: string, 
    body: Record<string, unknown>, 
    customBackendUrl?: string
): Promise<void> => {
    const baseUrl = (customBackendUrl || config.backend.defaultUrl || config.backendApiUrl || '').replace(/\/+$/, '');
    if (!baseUrl || !config.backendCallbackToken) {
        return;
    }

    const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

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
            logger.warn(`Backend webhook ${path} to ${url} returned ${response.status}: ${text}`);
        }
    } catch (error: any) {
        logger.error(error, `Backend webhook failed for ${path} to ${url}: ${error?.message || error}`);
    }
};

export const notifySessionStatus = async (
    payload: {
        userId: string;
        status: string;
        connectedNumber?: string | null;
        reason?: string;
    },
    targetBackendUrl?: string
) => {
    await notifyBackend('/api/v1/whatsapp-qr/webhook/session-status', payload, targetBackendUrl);
};

export const notifyMessageStatus = async (
    payload: {
        notificationId?: string;
        jobId?: string | number;
        userId?: string;
        targetNumber?: string;
        status: 'sent' | 'failed';
        error?: string;
        code?: string;
    },
    targetBackendUrl?: string
) => {
    if (!payload.notificationId && !payload.jobId) {
        return;
    }
    await notifyBackend('/api/v1/whatsapp-qr/webhook/message-status', payload, targetBackendUrl);
};

