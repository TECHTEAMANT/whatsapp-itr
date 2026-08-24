import { config } from '../config/env';
import { logger } from './logger';

const WEBHOOK_TIMEOUT_MS = 8000;

import { pool } from '../database/connection';

/**
 * Detects the environment string ('local', 'development', 'production') from URL or origin
 */
export const resolveEnvironment = (urlOrOrigin?: string): string => {
    const raw = (urlOrOrigin || '').toLowerCase();
    if (raw.includes('localhost') || raw.includes('127.0.0.1')) {
        return 'local';
    }
    if (raw.includes('dev') || raw.includes('apis-dev') || raw.includes('api-dev') || raw.includes('app-dev')) {
        return 'development';
    }
    if (raw.includes('app.accountsntax.com') || raw.includes('apis.accountsntax.com') || raw.includes('api.accountsntax.com')) {
        return 'production';
    }
    return config.env || 'development';
};

/**
 * Resolves the target backend API URL based on request Origin/Referer header or explicit URL/environment.
 * - app-dev.accountsntax.com -> Dev Backend
 * - app.accountsntax.com -> Prod Backend
 * - Fallback -> Default configured backend API URL
 */
export const resolveBackendUrl = (originOrReferer?: string, explicitUrl?: string, environment?: string): string => {
    if (explicitUrl) {
        return explicitUrl.replace(/\/+$/, '');
    }

    if (environment === 'production') {
        return config.backend.prodUrl || config.backend.defaultUrl;
    }
    if (environment === 'development' || environment === 'dev') {
        return config.backend.devUrl || config.backend.defaultUrl;
    }
    if (environment === 'local') {
        return config.backend.defaultUrl || config.backendApiUrl || 'http://localhost:5001';
    }

    const origin = (originOrReferer || '').toLowerCase();

    if (origin.includes('app-dev.accountsntax.com') || origin.includes('api-dev') || origin.includes('apis-dev')) {
        return config.backend.devUrl || config.backend.defaultUrl;
    }

    if (origin.includes('app.accountsntax.com') || origin.includes('api.accountsntax.com') || origin.includes('apis.accountsntax.com')) {
        return config.backend.prodUrl || config.backend.defaultUrl;
    }

    return config.backend.defaultUrl || config.backendApiUrl || config.backend.devUrl || config.backend.prodUrl;
};

/**
 * Automatically updates environment and backend_url for an existing session row in PostgreSQL
 * if it is currently NULL or out-of-date.
 */
export const syncSessionEnvironment = async (
    userId: string, 
    originOrReferer?: string, 
    explicitBackendUrl?: string, 
    explicitEnv?: string
): Promise<string> => {
    const backendUrl = resolveBackendUrl(originOrReferer, explicitBackendUrl, explicitEnv);
    const envName = explicitEnv || resolveEnvironment(backendUrl || originOrReferer);

    try {
        await pool.query(
            `UPDATE users_whatsapp_sessions 
             SET 
                backend_url = COALESCE(backend_url, $1),
                environment = COALESCE(environment, $2),
                updated_at = CURRENT_TIMESTAMP
             WHERE user_id = $3 AND (backend_url IS NULL OR environment IS NULL)`,
            [backendUrl, envName, userId]
        );
    } catch (error) {
        logger.error(error, `Error syncing session environment for user ${userId}:`);
    }

    return backendUrl;
};

/**
 * Retrieves the persisted backend URL for a user from PostgreSQL.
 */
export const getUserBackendUrl = async (userId: string): Promise<string | undefined> => {
    try {
        const { rows } = await pool.query(
            `SELECT backend_url FROM users_whatsapp_sessions WHERE user_id = $1`,
            [userId]
        );
        if (rows.length > 0 && rows[0].backend_url) {
            return rows[0].backend_url;
        }
    } catch (error) {
        logger.error(error, `Error fetching backend_url for user ${userId}:`);
    }
    return undefined;
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

