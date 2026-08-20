import { sessions } from './sessionManager';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { logger } from '../../utils/logger';

/**
 * Helper to determine MIME type from fileName, explicit mimetype, or file extension
 */
export const getMimeType = (fileName?: string, explicitMimeType?: string): string => {
    if (explicitMimeType && explicitMimeType.trim() !== '') {
        return explicitMimeType;
    }

    if (!fileName) {
        return 'application/pdf';
    }

    const ext = path.extname(fileName).toLowerCase();
    const mimeMap: Record<string, string> = {
        // Documents & PDFs
        '.pdf': 'application/pdf',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.doc': 'application/msword',
        '.txt': 'text/plain',
        '.rtf': 'application/rtf',
        // Spreadsheets
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.xls': 'application/vnd.ms-excel',
        '.csv': 'text/csv',
        // Presentations
        '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        '.ppt': 'application/vnd.ms-powerpoint',
        // Archives
        '.zip': 'application/zip',
        '.rar': 'application/x-rar-compressed',
        '.7z': 'application/x-7z-compressed',
        '.tar': 'application/x-tar',
        '.gz': 'application/gzip',
        // Images
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        // Audio & Video
        '.mp4': 'video/mp4',
        '.mp3': 'audio/mpeg',
        // Web / Data
        '.json': 'application/json',
        '.xml': 'application/xml',
    };

    return mimeMap[ext] || 'application/octet-stream';
};

/**
 * Send a document directly from a local path
 */
export const sendPdfDocument = async (
    userId: string, 
    targetNumber: string, 
    pdfPath: string, 
    fileName: string, 
    caption?: string,
    explicitMimeType?: string
) => {
    const sock = sessions.get(userId);
    if (!sock) throw new Error('WhatsApp session not connected for this user.');

    // Format number to JID (e.g., 919876543210@s.whatsapp.net)
    const jid = targetNumber.includes('@') ? targetNumber : `${targetNumber}@s.whatsapp.net`;

    const fileBuffer = fs.readFileSync(pdfPath);
    const resolvedMimeType = getMimeType(fileName || pdfPath, explicitMimeType);

    // Mimic typing before sending the document
    await sock.sendPresenceUpdate('composing', jid);
    await new Promise(resolve => setTimeout(resolve, 2000));
    await sock.sendPresenceUpdate('paused', jid);

    await sock.sendMessage(jid, {
        document: fileBuffer,
        mimetype: resolvedMimeType,
        fileName: fileName,
        caption: caption
    });
};

/**
 * Helper to download file from URL to memory buffer
 */
const downloadFileBuffer = (url: string): Promise<Buffer> => {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        
        client.get(url, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`Failed to download file, status code: ${res.statusCode}`));
            }
            
            const data: Buffer[] = [];
            res.on('data', (chunk) => data.push(chunk));
            res.on('end', () => resolve(Buffer.concat(data)));
        }).on('error', (err) => reject(err));
    });
};

/**
 * Download a document from a URL and send it
 */
export const sendPdfDocumentFromUrl = async (
    userId: string,
    targetNumber: string,
    pdfUrl: string,
    fileName: string,
    caption?: string,
    explicitMimeType?: string
) => {
    const sock = sessions.get(userId);
    if (!sock) throw new Error('WhatsApp session not connected for this user.');

    const jid = targetNumber.includes('@') ? targetNumber : `${targetNumber}@s.whatsapp.net`;
    
    logger.info(`Downloading file for user ${userId} from ${pdfUrl}`);
    const fileBuffer = await downloadFileBuffer(pdfUrl);
    
    const resolvedMimeType = getMimeType(fileName || pdfUrl, explicitMimeType);
    logger.info(`Sending document (${resolvedMimeType}) to ${targetNumber} for user ${userId}`);
    
    // Mimic typing before sending the document
    await sock.sendPresenceUpdate('composing', jid);
    await new Promise(resolve => setTimeout(resolve, 2000));
    await sock.sendPresenceUpdate('paused', jid);

    await sock.sendMessage(jid, {
        document: fileBuffer,
        mimetype: resolvedMimeType,
        fileName: fileName,
        caption: caption
    });
};

/**
 * Send a document from a base64 string
 */
export const sendPdfDocumentFromBase64 = async (
    userId: string,
    targetNumber: string,
    pdfBase64: string,
    fileName: string,
    caption?: string,
    explicitMimeType?: string
) => {
    const sock = sessions.get(userId);
    if (!sock) throw new Error('WhatsApp session not connected for this user.');

    const jid = targetNumber.includes('@') ? targetNumber : `${targetNumber}@s.whatsapp.net`;
    
    // Check if data URI contains a MIME type (e.g., data:image/png;base64,...)
    const dataUriMatch = pdfBase64.match(/^data:([^;]+);base64,/);
    const mimeFromDataUri = dataUriMatch ? dataUriMatch[1] : undefined;

    // Strip any data URI prefix if it exists
    const base64Data = pdfBase64.replace(/^data:[^;]+;base64,/, '');
    const fileBuffer = Buffer.from(base64Data, 'base64');
    
    const resolvedMimeType = explicitMimeType || mimeFromDataUri || getMimeType(fileName);

    logger.info(`Sending Base64 document (${resolvedMimeType}) to ${targetNumber} for user ${userId}`);
    
    // Mimic typing before sending the document
    await sock.sendPresenceUpdate('composing', jid);
    await new Promise(resolve => setTimeout(resolve, 2000));
    await sock.sendPresenceUpdate('paused', jid);

    await sock.sendMessage(jid, {
        document: fileBuffer,
        mimetype: resolvedMimeType,
        fileName: fileName,
        caption: caption
    });
};

// Aliases for general document sending
export const sendDocument = sendPdfDocument;
export const sendDocumentFromUrl = sendPdfDocumentFromUrl;
export const sendDocumentFromBase64 = sendPdfDocumentFromBase64;
