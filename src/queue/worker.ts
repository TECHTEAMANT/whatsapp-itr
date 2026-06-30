import { Worker, Job } from 'bullmq';
import { redis } from '../database/redis';
import { logger } from '../utils/logger';
import { sendPdfDocumentFromUrl, sendPdfDocumentFromBase64 } from '../services/whatsapp/messageSender';
import { pool } from '../database/connection';

export const setupWorker = () => {
    const worker = new Worker('messageQueue', async (job: Job) => {
        logger.info(`Processing job ${job.id} of type ${job.name}`);
        
        if (job.name === 'sendPdf') {
            const { userId, targetNumber, pdfUrl, pdfBase64, caption, fileName } = job.data;
            
            try {
                // Send PDF document logic
                if (pdfBase64) {
                    await sendPdfDocumentFromBase64(userId, targetNumber, pdfBase64, fileName, caption);
                } else if (pdfUrl) {
                    await sendPdfDocumentFromUrl(userId, targetNumber, pdfUrl, fileName, caption);
                } else {
                    throw new Error('Neither pdfUrl nor pdfBase64 was provided in job data');
                }
                
                // Log success in database
                await pool.query(
                    `INSERT INTO message_logs (user_id, target_number, message_type, status) VALUES ($1, $2, $3, $4)`,
                    [userId, targetNumber, 'pdf', 'sent']
                );
                
                logger.info(`Successfully processed job ${job.id}`);
            } catch (error: any) {
                logger.error(`Error processing job ${job.id}: ${error.message}`);
                
                // Log failure in database
                await pool.query(
                    `INSERT INTO message_logs (user_id, target_number, message_type, status, error_message) VALUES ($1, $2, $3, $4, $5)`,
                    [userId, targetNumber, 'pdf', 'failed', error.message]
                );
                
                throw error;
            }
        }
    }, {
        connection: redis as any,
        concurrency: 5, // Process up to 5 jobs concurrently across the worker
        limiter: {
            max: 10,
            duration: 10000 // Max 10 jobs per 10 seconds to avoid WhatsApp rate limits
        }
    });

    worker.on('failed', (job, err) => {
        logger.error(`Job ${job?.id} failed with error ${err.message}`);
    });

    logger.info('Message worker setup completed');
};
