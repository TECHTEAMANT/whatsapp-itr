import { Worker, Job } from 'bullmq';
import { redis } from '../database/redis';
import { logger } from '../utils/logger';
import { sendPdfDocumentFromUrl, sendPdfDocumentFromBase64 } from '../services/whatsapp/messageSender';
import { pool } from '../database/connection';
import { sessions } from '../services/whatsapp/sessionManager';

export const setupWorker = () => {
    const worker = new Worker('messageQueue', async (job: Job) => {
        logger.info(`Processing job ${job.id} of type ${job.name}`);
        
        if (job.name === 'sendPdf' || job.name === 'sendDocument') {
            const { userId, targetNumber, pdfUrl, pdfBase64, caption, fileName, mimetype, url, base64 } = job.data;
            const fileUrl = pdfUrl || url;
            const fileBase64 = pdfBase64 || base64;
            
            try {
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
                
                logger.info(`Successfully processed job ${job.id}`);
            } catch (error: any) {
                logger.error(`Error processing job ${job.id}: ${error.message}`);
                
                // Log failure in database
                await pool.query(
                    `INSERT INTO message_logs (user_id, target_number, message_type, status, error_message) VALUES ($1, $2, $3, $4, $5)`,
                    [userId, targetNumber, 'document', 'failed', error.message]
                );
                
                throw error;
            }
        } else if (job.name === 'sendExcelMessage') {
            const { userId, targetNumber, messageText } = job.data;
            try {
                const sock = sessions.get(userId);
                if (!sock) throw new Error('WhatsApp session not connected for this user.');
                
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
                
                logger.info(`Successfully processed excel text job ${job.id}`);
            } catch (error: any) {
                logger.error(`Error processing excel text job ${job.id}: ${error.message}`);
                
                // Log failure in database
                await pool.query(
                    `INSERT INTO message_logs (user_id, target_number, message_type, status, error_message) VALUES ($1, $2, $3, $4, $5)`,
                    [userId, targetNumber, 'text', 'failed', error.message]
                );
                
                throw error;
            }
        }
    }, {
        connection: redis as any,
        concurrency: 1, // MUST be 1. WhatsApp bans accounts that send concurrent bulk messages. Simulates a single human.
        limiter: {
            max: 1, // Only send 1 message...
            duration: 45000 // ...every 45 seconds. This is a much safer threshold for WhatsApp's anti-spam system.
        }
    });

    worker.on('failed', (job, err) => {
        logger.error(`Job ${job?.id} failed with error ${err.message}`);
    });

    logger.info('Message worker setup completed');
};
