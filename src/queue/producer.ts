import { Queue } from 'bullmq';
import path from 'path';
import { redis } from '../database/redis';
import { logger } from '../utils/logger';
import { getSenderNumber } from '../services/whatsapp/sessionManager';

export const SENDER_MESSAGE_INTERVAL_MS = 30000; // 30 seconds delay between messages on the same sender account

// Lua script to atomically calculate and reserve the next sending window for a specific sender number
const SCHEDULE_LUA_SCRIPT = `
local current_available = redis.call('GET', KEYS[1])
local now = tonumber(ARGV[1])
local cooldown = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])

local scheduled_time = now

if current_available then
    local next_time = tonumber(current_available)
    if next_time > now then
        scheduled_time = next_time
    end
end

local next_available = scheduled_time + cooldown
redis.call('SET', KEYS[1], tostring(next_available), 'EX', ttl)

local delay = scheduled_time - now
if delay < 0 then
    delay = 0
end

return delay
`;

/**
 * Atomically computes and reserves the delay for a given sender WhatsApp number.
 */
export const calculateSenderDelay = async (senderNumber: string): Promise<number> => {
    try {
        const redisKey = `whatsapp:sender_next_available:${senderNumber}`;
        const now = Date.now().toString();
        const cooldown = SENDER_MESSAGE_INTERVAL_MS.toString();
        const ttl = '86400'; // 24h key expiration

        const result = await redis.eval(
            SCHEDULE_LUA_SCRIPT,
            1,
            redisKey,
            now,
            cooldown,
            ttl
        );

        const delay = typeof result === 'number' ? result : parseInt(String(result), 10) || 0;
        return delay;
    } catch (error) {
        logger.error(`Error calculating sender delay for ${senderNumber}: ${error}`);
        return 0;
    }
};

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
    mimetype?: string,
    extras?: {
        notificationId?: string;
        callbackUrl?: string;
        backendUrl?: string;
    }
) => {
    try {
        const senderNumber = await getSenderNumber(userId);
        const delay = await calculateSenderDelay(senderNumber);
        const finalFileName = resolveFileName(fileName, pdfUrl);

        const job = await messageQueue.add(
            'sendPdf',
            {
                userId,
                senderNumber,
                targetNumber,
                pdfUrl,
                pdfBase64,
                caption,
                fileName: finalFileName,
                mimetype,
                notificationId: extras?.notificationId,
                callbackUrl: extras?.callbackUrl,
                backendUrl: extras?.backendUrl
            },
            {
                delay
            }
        );

        logger.info(
            `Added job ${job.id} to queue for user ${userId} (sender: ${senderNumber}) to ${targetNumber} with delay: ${delay}ms`
        );
        return { jobId: job.id, delay, senderNumber };
    } catch (error) {
        logger.error(`Failed to add job to queue: ${error}`);
        throw error;
    }
};

export const addDocumentJobToQueue = addPdfJobToQueue;

export const addExcelMessageJobToQueue = async (
    userId: string,
    targetNumber: string,
    messageText: string,
    extras?: {
        notificationId?: string;
        callbackUrl?: string;
        backendUrl?: string;
    }
) => {
    try {
        const senderNumber = await getSenderNumber(userId);
        const delay = await calculateSenderDelay(senderNumber);

        const job = await messageQueue.add(
            'sendExcelMessage',
            {
                userId,
                senderNumber,
                targetNumber,
                messageText,
                notificationId: extras?.notificationId,
                callbackUrl: extras?.callbackUrl,
                backendUrl: extras?.backendUrl
            },
            {
                delay
            }
        );


        logger.info(
            `Added excel job ${job.id} for user ${userId} (sender: ${senderNumber}) to ${targetNumber} with delay: ${delay}ms`
        );
        return { jobId: job.id, delay, senderNumber };
    } catch (error) {
        logger.error(`Failed to add excel job to queue: ${error}`);
        throw error;
    }
};

