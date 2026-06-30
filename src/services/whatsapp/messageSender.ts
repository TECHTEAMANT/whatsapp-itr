import { sessions } from './sessionManager';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { logger } from '../../utils/logger';

/**
 * Send a PDF file directly from a local path
 */
export const sendPdfDocument = async (
    userId: string, 
    targetNumber: string, 
    pdfPath: string, 
    fileName: string, 
    caption?: string
) => {
    const sock = sessions.get(userId);
    if (!sock) throw new Error('WhatsApp session not connected for this user.');

    // Format number to JID (e.g., 919876543210@s.whatsapp.net)
    const jid = targetNumber.includes('@') ? targetNumber : `${targetNumber}@s.whatsapp.net`;

    const pdfBuffer = fs.readFileSync(pdfPath);

    await sock.sendMessage(jid, {
        document: pdfBuffer,
        mimetype: 'application/pdf',
        fileName: fileName,
        caption: caption
    });
};

/**
 * Helper to download PDF from URL to memory buffer
 */
const downloadPdfBuffer = (url: string): Promise<Buffer> => {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        
        client.get(url, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`Failed to download PDF, status code: ${res.statusCode}`));
            }
            
            const data: Buffer[] = [];
            res.on('data', (chunk) => data.push(chunk));
            res.on('end', () => resolve(Buffer.concat(data)));
        }).on('error', (err) => reject(err));
    });
};

/**
 * Download a PDF from a URL and send it
 */
export const sendPdfDocumentFromUrl = async (
    userId: string,
    targetNumber: string,
    pdfUrl: string,
    fileName: string,
    caption?: string
) => {
    const sock = sessions.get(userId);
    if (!sock) throw new Error('WhatsApp session not connected for this user.');

    const jid = targetNumber.includes('@') ? targetNumber : `${targetNumber}@s.whatsapp.net`;
    
    logger.info(`Downloading PDF for user ${userId} from ${pdfUrl}`);
    const pdfBuffer = await downloadPdfBuffer(pdfUrl);
    
    logger.info(`Sending PDF to ${targetNumber} for user ${userId}`);
    await sock.sendMessage(jid, {
        document: pdfBuffer,
        mimetype: 'application/pdf',
        fileName: fileName,
        caption: caption
    });
};

/**
 * Send a PDF from a base64 string
 */
export const sendPdfDocumentFromBase64 = async (
    userId: string,
    targetNumber: string,
    pdfBase64: string,
    fileName: string,
    caption?: string
) => {
    const sock = sessions.get(userId);
    if (!sock) throw new Error('WhatsApp session not connected for this user.');

    const jid = targetNumber.includes('@') ? targetNumber : `${targetNumber}@s.whatsapp.net`;
    
    // Strip the "data:application/pdf;base64," prefix if it exists
    const base64Data = pdfBase64.replace(/^data:application\/pdf;base64,/, '');
    const pdfBuffer = Buffer.from(base64Data, 'base64');
    
    logger.info(`Sending Base64 PDF to ${targetNumber} for user ${userId}`);
    await sock.sendMessage(jid, {
        document: pdfBuffer,
        mimetype: 'application/pdf',
        fileName: fileName,
        caption: caption
    });
};
