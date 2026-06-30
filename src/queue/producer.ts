import { Queue } from 'bullmq';
import { redis } from '../database/redis';
import { logger } from '../utils/logger';

// Queue for sending messages
export const messageQueue = new Queue('messageQueue', {
    connection: redis as any,
    defaultJobOptions: {
        removeOnComplete: true,
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 1000
        }
    }
});

export const addPdfJobToQueue = async (
    userId: string,
    targetNumber: string,
    pdfUrl?: string,
    pdfBase64?: string,
    caption?: string,
    fileName?: string
) => {
    try {
        const job = await messageQueue.add('sendPdf', {
            userId,
            targetNumber,
            pdfUrl,
            pdfBase64,
            caption,
            fileName: fileName || 'document.pdf'
        });
        logger.info(`Added job ${job.id} to queue for user ${userId} to number ${targetNumber}`);
        return job.id;
    } catch (error) {
        logger.error(`Failed to add job to queue: ${error}`);
        throw error;
    }
};
