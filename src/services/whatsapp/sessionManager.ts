import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { logger } from '../../utils/logger';
import { pool } from '../../database/connection';
import fs from 'fs';
import path from 'path';

// Stores active socket connections in memory
export const sessions = new Map<string, any>();

// Ensure sessions directory exists
const sessionsDir = path.join(process.cwd(), 'sessions');
if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
}

export const initSession = async (userId: string, onQr?: (qr: string) => void) => {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionsDir, userId));
        const { version } = await fetchLatestBaileysVersion();
        
        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: logger.child({ level: 'silent' }) as any, // Suppress excessive Baileys logs
            syncFullHistory: false, // Don't fetch history to save memory
            browser: ['AccountsNTax', 'Chrome', '1.0.0'], // Override default browser to avoid WhatsApp blocking
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr && onQr) {
                logger.info(`QR code generated for user ${userId}`);
                onQr(qr);
            }

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                logger.info(`Connection closed for ${userId}, reconnecting: ${shouldReconnect}`);
                
                if (shouldReconnect) {
                    setTimeout(() => initSession(userId, onQr), 5000);
                } else {
                    sessions.delete(userId);
                    // Update DB status to disconnected
                    await pool.query(
                        `INSERT INTO users_whatsapp_sessions (user_id, session_status) VALUES ($1, $2)
                         ON CONFLICT (user_id) DO UPDATE SET session_status = $2`,
                        [userId, 'DISCONNECTED']
                    );
                    
                    // Cleanup local session folder if logged out intentionally
                    const userSessionDir = path.join(sessionsDir, userId);
                    if (fs.existsSync(userSessionDir)) {
                        fs.rmSync(userSessionDir, { recursive: true, force: true });
                    }
                }
            } else if (connection === 'open') {
                logger.info(`Session connected for ${userId}`);
                sessions.set(userId, sock);
                
                // Save connected state in DB
                const userNumber = sock.user?.id.split(':')[0] || '';
                await pool.query(
                    `INSERT INTO users_whatsapp_sessions (user_id, whatsapp_number, session_status) 
                     VALUES ($1, $2, $3)
                     ON CONFLICT (user_id) DO UPDATE SET whatsapp_number = $2, session_status = $3`,
                    [userId, userNumber, 'CONNECTED']
                );
            }
        });

        sock.ev.on('creds.update', saveCreds);
        return sock;
    } catch (error) {
        logger.error(error, `Error initializing session for user ${userId}:`);
        throw error;
    }
};

// Auto-reconnect all previously connected sessions on startup
export const autoReconnectSessions = async () => {
    try {
        const { rows } = await pool.query(
            `SELECT user_id FROM users_whatsapp_sessions WHERE session_status = 'CONNECTED'`
        );
        
        logger.info(`Found ${rows.length} sessions to auto-reconnect`);
        
        for (const row of rows) {
            await initSession(row.user_id);
            // Optional delay between reconnects to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    } catch (error) {
        logger.error(error, 'Error during auto-reconnect sessions:');
    }
};
