import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { logger } from '../../utils/logger';
import { pool } from '../../database/connection';
import { notifySessionStatus, getUserBackendUrl, resolveEnvironment } from '../../utils/backendWebhook';
import fs from 'fs';
import path from 'path';

// Stores active socket connections in memory
export const sessions = new Map<string, any>();

// Stores the target backend API URL for each user session (dev vs prod)
export const userBackendUrls = new Map<string, string>();

// Stores reconnect attempt counts per user
const reconnectAttempts = new Map<string, number>();

// Ensure sessions directory exists
const sessionsDir = path.join(process.cwd(), 'sessions');
if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
}

export const initSession = async (
    userId: string, 
    onQr?: (qr: string) => void, 
    targetBackendUrl?: string,
    environment?: string
) => {
    // If not provided in arguments, try retrieving from in-memory map or DB
    let backendUrl = targetBackendUrl || userBackendUrls.get(userId);
    if (!backendUrl) {
        backendUrl = await getUserBackendUrl(userId);
    }
    if (backendUrl) {
        userBackendUrls.set(userId, backendUrl);
    }

    const envName = environment || resolveEnvironment(backendUrl);

    try {
        const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionsDir, userId));
        const { version } = await fetchLatestBaileysVersion();
        
        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: logger.child({ level: 'silent' }) as any, // Suppress excessive Baileys logs
            syncFullHistory: false, // Don't fetch history to save memory
            browser: ['Mac OS', 'Chrome', '121.0.6167.159'], // Use standard desktop browser to avoid WhatsApp blocking and sync issues
            keepAliveIntervalMs: 30000, // Revert to default 30s to keep connection healthy and avoid WhatsApp pushing sync notifications
            markOnlineOnConnect: true, // Mark online to resolve the persistent "Checking for new messages" / "Syncing" notification
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr && onQr) {
                logger.info(`QR code generated for user ${userId}`);
                onQr(qr);
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
                const errorMessage = (lastDisconnect?.error as Error)?.message || '';
                
                // Identify permanent disconnects (logged out, forbidden, replaced session, bad session)
                const isPermanentDisconnect = 
                    statusCode === DisconnectReason.loggedOut ||
                    statusCode === DisconnectReason.forbidden ||
                    statusCode === DisconnectReason.badSession ||
                    statusCode === DisconnectReason.connectionReplaced ||
                    /logged out|stream:error \(unauthorized\)|device unlinked/i.test(errorMessage);

                logger.info(`Connection closed for user ${userId}. StatusCode: ${statusCode}, Reason: ${errorMessage}, isPermanent: ${isPermanentDisconnect}`);

                if (sessions.get(userId) === sock) {
                    sessions.delete(userId);
                }

                const resolvedBackendUrl = userBackendUrls.get(userId) || (await getUserBackendUrl(userId));

                if (isPermanentDisconnect) {
                    reconnectAttempts.delete(userId);

                    try {
                        sock.ev.removeAllListeners('creds.update');
                        sock.end(undefined);
                    } catch (err: any) {
                        logger.warn(`Notice: Socket already closed or error ending socket for ${userId}: ${err?.message || err}`);
                    }

                    // Update DB status to disconnected
                    await pool.query(
                        `INSERT INTO users_whatsapp_sessions (user_id, session_status, backend_url, environment) 
                         VALUES ($1, $2, $3, $4)
                         ON CONFLICT (user_id) DO UPDATE SET session_status = $2, backend_url = COALESCE($3, users_whatsapp_sessions.backend_url), environment = COALESCE($4, users_whatsapp_sessions.environment), updated_at = CURRENT_TIMESTAMP`,
                        [userId, 'DISCONNECTED', resolvedBackendUrl || null, envName]
                    );
                    
                    // Cleanup local session folder if logged out permanently
                    const userSessionDir = path.join(sessionsDir, userId);
                    if (fs.existsSync(userSessionDir)) {
                        fs.rmSync(userSessionDir, { recursive: true, force: true });
                    }

                    logger.info(`Sending DISCONNECTED webhook for user ${userId} to backend: ${resolvedBackendUrl || 'default'}`);
                    await notifySessionStatus({
                        userId,
                        status: 'DISCONNECTED',
                        connectedNumber: null,
                        reason: 'logged_out'
                    }, resolvedBackendUrl).catch((err) => {
                        logger.error(err, `Failed to notify backend on permanent logout for ${userId}`);
                    });
                } else {
                    // Temporary disconnect / network loss -> Retry with backoff up to 3 times
                    const currentAttempts = (reconnectAttempts.get(userId) || 0) + 1;
                    
                    if (currentAttempts <= 3) {
                        reconnectAttempts.set(userId, currentAttempts);
                        logger.info(`Attempting reconnect ${currentAttempts}/3 for user ${userId} in ${currentAttempts * 5}s`);

                        await pool.query(
                            `INSERT INTO users_whatsapp_sessions (user_id, session_status, backend_url, environment) 
                             VALUES ($1, $2, $3, $4)
                             ON CONFLICT (user_id) DO UPDATE SET session_status = $2, backend_url = COALESCE($3, users_whatsapp_sessions.backend_url), environment = COALESCE($4, users_whatsapp_sessions.environment), updated_at = CURRENT_TIMESTAMP`,
                            [userId, 'RECONNECTING', resolvedBackendUrl || null, envName]
                        );

                        setTimeout(() => {
                            if (!sessions.has(userId)) {
                                initSession(userId, onQr, resolvedBackendUrl, envName).catch((error) => {
                                    logger.error(error, `Error reconnecting session for user ${userId} on attempt ${currentAttempts}:`);
                                });
                            }
                        }, currentAttempts * 5000);
                    } else {
                        // Max retries exceeded -> Mark as DISCONNECTED and notify backend
                        logger.warn(`Max reconnect retries exceeded for user ${userId}. Marking DISCONNECTED and notifying backend.`);
                        reconnectAttempts.delete(userId);

                        await pool.query(
                            `INSERT INTO users_whatsapp_sessions (user_id, session_status, backend_url, environment) 
                             VALUES ($1, $2, $3, $4)
                             ON CONFLICT (user_id) DO UPDATE SET session_status = $2, backend_url = COALESCE($3, users_whatsapp_sessions.backend_url), environment = COALESCE($4, users_whatsapp_sessions.environment), updated_at = CURRENT_TIMESTAMP`,
                            [userId, 'DISCONNECTED', resolvedBackendUrl || null, envName]
                        );

                        await notifySessionStatus({
                            userId,
                            status: 'DISCONNECTED',
                            connectedNumber: null,
                            reason: 'connection_lost'
                        }, resolvedBackendUrl).catch((err) => {
                            logger.error(err, `Failed to notify backend on connection loss for ${userId}`);
                        });
                    }
                }
            } else if (connection === 'open') {
                logger.info(`Session connected for ${userId}`);
                reconnectAttempts.delete(userId);
                sessions.set(userId, sock);
                
                // Save connected state in DB along with backend_url and environment
                const userNumber = sock.user?.id.split(':')[0] || '';
                const resolvedBackendUrl = userBackendUrls.get(userId) || (await getUserBackendUrl(userId));

                await pool.query(
                    `INSERT INTO users_whatsapp_sessions (user_id, whatsapp_number, session_status, backend_url, environment) 
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (user_id) DO UPDATE SET 
                        whatsapp_number = $2, 
                        session_status = $3, 
                        backend_url = COALESCE($4, users_whatsapp_sessions.backend_url),
                        environment = COALESCE($5, users_whatsapp_sessions.environment),
                        updated_at = CURRENT_TIMESTAMP`,
                    [userId, userNumber, 'CONNECTED', resolvedBackendUrl || null, envName]
                );

                notifySessionStatus({
                    userId,
                    status: 'CONNECTED',
                    connectedNumber: userNumber ? `+${userNumber}` : null,
                    reason: 'connected'
                }, resolvedBackendUrl).catch(() => undefined);
            }
        });

        sock.ev.on('creds.update', async () => {
            try {
                const userDir = path.join(sessionsDir, userId);
                if (fs.existsSync(userDir)) {
                    await saveCreds();
                }
            } catch (err: any) {
                logger.warn(`Could not save credentials for user ${userId}: ${err?.message || err}`);
            }
        });
        return sock;
    } catch (error) {
        logger.error(error, `Error initializing session for user ${userId}:`);
        throw error;
    }
};


// Auto-reconnect all previously connected sessions on startup with persistent backend_url & environment
export const autoReconnectSessions = async () => {
    try {
        const { rows } = await pool.query(
            `SELECT user_id, backend_url, environment FROM users_whatsapp_sessions WHERE session_status IN ('CONNECTED', 'RECONNECTING')`
        );
        
        logger.info(`Found ${rows.length} sessions to auto-reconnect`);
        
        for (const row of rows) {
            await initSession(row.user_id, undefined, row.backend_url, row.environment);
            // Optional delay between reconnects to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    } catch (error) {
        logger.error(error, 'Error during auto-reconnect sessions:');
    }
};

/**
 * Resolves the underlying WhatsApp phone number for a given user.
 * 1. Checks active memory socket first.
 * 2. Checks DB session record next.
 * 3. Falls back to sanitized userId if not found.
 */
export const getSenderNumber = async (userId: string): Promise<string> => {
    try {
        // 1. Check live in-memory session socket
        const sock = sessions.get(userId);
        if (sock?.user?.id) {
            const raw = sock.user.id.split(':')[0] || '';
            const digits = raw.replace(/\D/g, '');
            if (digits) return digits;
        }

        // 2. Check DB record
        const { rows } = await pool.query(
            `SELECT whatsapp_number FROM users_whatsapp_sessions WHERE user_id = $1`,
            [userId]
        );
        if (rows.length > 0 && rows[0].whatsapp_number) {
            const digits = rows[0].whatsapp_number.replace(/\D/g, '');
            if (digits) return digits;
        }

        // 3. Fallback to userId
        const userDigits = userId.replace(/\D/g, '');
        return userDigits || userId;
    } catch (error) {
        logger.error(error, `Error resolving sender number for user ${userId}:`);
        const userDigits = userId.replace(/\D/g, '');
        return userDigits || userId;
    }
};


export const logoutSession = async (userId: string) => {
    const sock = sessions.get(userId);
    if (sock) {
        try {
            sock.ev.removeAllListeners('creds.update');
            await sock.logout();
        } catch (error: any) {
            logger.warn(`Error during socket logout for ${userId}: ${error?.message || error}`);
        }
        if (sessions.get(userId) === sock) {
            sessions.delete(userId);
        }
        try {
            sock.end(undefined);
        } catch (err: any) {
            logger.warn(`Notice: Socket already closed or error ending socket during logout for ${userId}: ${err?.message || err}`);
        }
    }

    const userSessionDir = path.join(sessionsDir, userId);
    if (fs.existsSync(userSessionDir)) {
        fs.rmSync(userSessionDir, { recursive: true, force: true });
    }

    await pool.query(
        `INSERT INTO users_whatsapp_sessions (user_id, session_status) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET session_status = $2, updated_at = CURRENT_TIMESTAMP`,
        [userId, 'DISCONNECTED']
    );

    const targetBackendUrl = userBackendUrls.get(userId) || (await getUserBackendUrl(userId));

    await notifySessionStatus({
        userId,
        status: 'DISCONNECTED',
        connectedNumber: null,
        reason: 'logout'
    }, targetBackendUrl);

    userBackendUrls.delete(userId);
    reconnectAttempts.delete(userId);
};

