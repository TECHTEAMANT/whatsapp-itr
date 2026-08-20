import { Queue } from 'bullmq';
import path from 'path';
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

/**
 * Resolves the filename from the provided fileName or extracts it from the URL
 */
const resolveFileName = (fileName?: string, url?: string): string => {
    if (fileName && fileName.trim()) {
        return fileName.trim();
    }
    if (url) {
        try {
            const cleanUrl = url.split('?')[0].split('#')[0];
            const extracted = path.basename(cleanUrl);
            if (extracted && path.extname(extracted)) {
                return extracted;
            }
        } catch {
            // fallback
        }
    }
    return 'document.pdf';
};

export const addPdfJobToQueue = async (
    userId: string,
    targetNumber: string,
    pdfUrl?: string,
    pdfBase64?: string,
    caption?: string,
    fileName?: string,
    mimetype?: string
) => {
    try {
        const finalFileName = resolveFileName(fileName, pdfUrl);
        const job = await messageQueue.add('sendPdf', {
            userId,
            targetNumber,
            pdfUrl,
            pdfBase64,
            caption,
            fileName: finalFileName,
            mimetype
        });
        logger.info(`Added job ${job.id} to queue for user ${userId} to number ${targetNumber}`);
        return job.id;
    } catch (error) {
        logger.error(`Failed to add job to queue: ${error}`);
        throw error;
    }
};

export const addDocumentJobToQueue = addPdfJobToQueue;

export const addExcelMessageJobToQueue = async (
    userId: string,
    targetNumber: string,
    messageText: string
) => {
    try {
        const job = await messageQueue.add('sendExcelMessage', {
            userId,
            targetNumber,
            messageText
        });
        return job.id;
    } catch (error) {
        logger.error(`Failed to add excel job to queue: ${error}`);
        throw error;
    }
};
