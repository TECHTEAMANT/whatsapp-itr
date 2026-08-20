import { Worker, Job } from 'bullmq';
import { redis } from '../database/redis';
import { logger } from '../utils/logger';
import { sendPdfDocumentFromUrl, sendPdfDocumentFromBase64 } from '../services/whatsapp/messageSender';
import { pool } from '../database/connection';
import { sessions, getSenderNumber } from '../services/whatsapp/sessionManager';

export const setupWorker = () => {
    const worker = new Worker('messageQueue', async (job: Job) => {
        const sender = job.data.senderNumber || await getSenderNumber(job.data.userId);
        logger.info(`Processing job ${job.id} of type ${job.name} for user ${job.data.userId} (Sender Account: ${sender})`);
        
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
                
                logger.info(`Successfully processed job ${job.id} for user ${userId} (Sender Account: ${sender})`);
            } catch (error: any) {
                logger.error(`Error processing job ${job.id} for sender ${sender}: ${error.message}`);
                
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
                
                logger.info(`Successfully processed excel text job ${job.id} for user ${userId} (Sender Account: ${sender})`);
            } catch (error: any) {
                logger.error(`Error processing excel text job ${job.id} for sender ${sender}: ${error.message}`);
                
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
        concurrency: 50, // Parallel sends across different WhatsApp accounts. Same-account rate limits are enforced dynamically via per-sender scheduling.
    });

    worker.on('failed', (job, err) => {
        logger.error(`Job ${job?.id} failed with error ${err.message}`);
    });

    logger.info('Message worker setup completed (concurrency: 50)');
};

