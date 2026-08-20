import { Worker, Job } from 'bullmq';
import { redis } from '../database/redis';
import { logger } from '../utils/logger';
import { sendPdfDocumentFromUrl, sendPdfDocumentFromBase64 } from '../services/whatsapp/messageSender';
import { pool } from '../database/connection';
import { sessions, getSenderNumber } from '../services/whatsapp/sessionManager';
import { notifyMessageStatus } from '../utils/backendWebhook';

// Rate limit interval per WhatsApp sender number (30 seconds)
const RATE_LIMIT_MS = 30000;

/**
 * Resolves the sender's device key (WhatsApp phone number or fallback userId)
 */
const getSenderDeviceKey = async (userId: string): Promise<string> => {
    const sock = sessions.get(userId);
    const liveNumber = sock?.user?.id?.split(':')[0];
    if (liveNumber) return `num:${liveNumber}`;

    try {
        const { rows } = await pool.query(
            `SELECT whatsapp_number FROM users_whatsapp_sessions WHERE user_id = $1`,
            [userId]
        );
        const dbNumber = rows[0]?.whatsapp_number;
        if (dbNumber) {
            return `num:${dbNumber}`;
        }
    } catch {
        // fallback
    }

    return `user:${userId}`;
};

/**
 * Atomically checks and reserves a send slot for a specific WhatsApp sender number.
 * Different numbers send with 0 wait time in parallel.
 * The same number is throttled with a 30-second interval.
 */
const acquireSenderSlot = async (deviceKey: string): Promise<void> => {
    const redisKey = `whatsapp:rate_limit:${deviceKey}`;
    const now = Date.now();

    const luaScript = `
        local key = KEYS[1]
        local now = tonumber(ARGV[1])
        local interval = tonumber(ARGV[2])
        
        local nextAvailable = redis.call('GET', key)
        if not nextAvailable or tonumber(nextAvailable) <= now then
            local newNext = now + interval
            redis.call('SET', key, newNext, 'PX', interval * 5)
            return 0
        else
            local waitMs = tonumber(nextAvailable) - now
            local newNext = tonumber(nextAvailable) + interval
            redis.call('SET', key, newNext, 'PX', (waitMs + interval) * 2)
            return waitMs
        end
    `;

    const waitMs = (await redis.eval(luaScript, 1, redisKey, now, RATE_LIMIT_MS)) as number;

    if (waitMs > 0) {
        logger.info(`Rate limit active for sender ${deviceKey}. Waiting ${Math.round(waitMs / 1000)}s before sending.`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
};

export const setupWorker = () => {
    const worker = new Worker('messageQueue', async (job: Job) => {
        const sender = job.data.senderNumber || await getSenderNumber(job.data.userId);
        logger.info(`Processing job ${job.id} of type ${job.name} for user ${job.data.userId} (Sender Account: ${sender})`);
        
        if (job.name === 'sendPdf' || job.name === 'sendDocument') {
            const { userId, targetNumber, pdfUrl, pdfBase64, caption, fileName, mimetype, url, base64, notificationId } = job.data;
            const fileUrl = pdfUrl || url;
            const fileBase64 = pdfBase64 || base64;
            
            try {
                const sock = sessions.get(userId);
                if (!sock) throw new Error('WhatsApp session not connected for this user.');

                // Rate limit check for this specific sender device/number
                const deviceKey = await getSenderDeviceKey(userId);
                await acquireSenderSlot(deviceKey);

                // Send document logic
                if (fileBase64) {
                    await sendPdfDocumentFromBase64(userId, targetNumber, fileBase64, fileName, caption, mimetype);
                } else if (fileUrl) {
                    await sendPdfDocumentFromUrl(userId, targetNumber, fileUrl, fileName, caption, mimetype);
                } else {
                    throw new Error('Neither fileUrl nor fileBase64 was provided in job data');
                }
                
                // Log success in database
                await pool.query(
                    `INSERT INTO message_logs (user_id, target_number, message_type, status) VALUES ($1, $2, $3, $4)`,
                    [userId, targetNumber, 'document', 'sent']
                );

                if (notificationId) {
                    await notifyMessageStatus({
                        notificationId,
                        jobId: job.id,
                        userId,
                        targetNumber,
                        status: 'sent'
                    }, job.data.backendUrl).catch(() => undefined);
                }
                
                logger.info(`Successfully processed job ${job.id} for user ${userId} (Sender Account: ${sender})`);
            } catch (error: any) {
                logger.error(`Error processing job ${job.id} for sender ${sender}: ${error.message}`);
                
                // Log failure in database
                await pool.query(
                    `INSERT INTO message_logs (user_id, target_number, message_type, status, error_message) VALUES ($1, $2, $3, $4, $5)`,
                    [userId, targetNumber, 'document', 'failed', error.message]
                );

                const message = error?.message || String(error);
                const disconnected = /not connected|session not connected/i.test(message);
                await notifyMessageStatus({
                    notificationId,
                    jobId: job.id,
                    userId,
                    targetNumber,
                    status: 'failed',
                    error: message,
                    code: disconnected ? 'session_disconnected' : undefined
                }, job.data.backendUrl).catch(() => undefined);
                
                throw error;
            }
        } else if (job.name === 'sendExcelMessage') {
            const { userId, targetNumber, messageText, notificationId } = job.data;
            try {
                const sock = sessions.get(userId);
                if (!sock) throw new Error('WhatsApp session not connected for this user.');

                // Rate limit check for this specific sender device/number
                const deviceKey = await getSenderDeviceKey(userId);
                await acquireSenderSlot(deviceKey);
                
                const jid = targetNumber.includes('@') ? targetNumber : `${targetNumber}@s.whatsapp.net`;

                // Mimic typing before sending the message
                await sock.sendPresenceUpdate('composing', jid);
                await new Promise(resolve => setTimeout(resolve, 2000)); // 2 seconds typing delay
                await sock.sendPresenceUpdate('paused', jid);

                await sock.sendMessage(jid, { text: messageText });
                
                // Log success in database
                await pool.query(
                    `INSERT INTO message_logs (user_id, target_number, message_type, status) VALUES ($1, $2, $3, $4)`,
                    [userId, targetNumber, 'text', 'sent']
                );

                if (notificationId) {
                    await notifyMessageStatus({
                        notificationId,
                        jobId: job.id,
                        userId,
                        targetNumber,
                        status: 'sent'
                    }, job.data.backendUrl).catch(() => undefined);
                }
                
                logger.info(`Successfully processed excel text job ${job.id} for user ${userId} (Sender Account: ${sender})`);
            } catch (error: any) {
                logger.error(`Error processing excel text job ${job.id} for sender ${sender}: ${error.message}`);
                
                // Log failure in database
                await pool.query(
                    `INSERT INTO message_logs (user_id, target_number, message_type, status, error_message) VALUES ($1, $2, $3, $4, $5)`,
                    [userId, targetNumber, 'text', 'failed', error.message]
                );

                const message = error?.message || String(error);
                const disconnected = /not connected|session not connected/i.test(message);
                await notifyMessageStatus({
                    notificationId,
                    jobId: job.id,
                    userId,
                    targetNumber,
                    status: 'failed',
                    error: message,
                    code: disconnected ? 'session_disconnected' : undefined
                }, job.data.backendUrl).catch(() => undefined);
                
                throw error;
            }
        }
    }, {
        connection: redis as any,
        concurrency: 50, // Parallel sends across different WhatsApp accounts. Same-account rate limits are enforced dynamically via per-sender scheduling.
    });

    worker.on('failed', (job, err) => {
        logger.error(`Job ${job?.id} failed with error ${err.message}`);
    });

    logger.info('Message worker setup completed (concurrency: 50)');
};

