import { Request, Response } from 'express';
import { initSession, sessions } from '../../services/whatsapp/sessionManager';
import { addPdfJobToQueue } from '../../queue/producer';
import QRCode from 'qrcode';
import { logger } from '../../utils/logger';
import { pool } from '../../database/connection';
import * as xlsx from 'xlsx';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { addExcelMessageJobToQueue } from '../../queue/producer';
export const startSession = async (req: Request, res: Response) => {
    const { userId } = req.body;
    
    if (!userId) {
        return res.status(400).json({ error: 'userId is required' });
    }

    if (sessions.has(userId)) {
        return res.json({ status: 'connected', message: 'Session is already active' });
    }

    try {
        
        const result = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                resolve({ status: 'timeout', message: 'QR code generation timed out' });
            }, 15000); // 15s timeout

            initSession(userId, async (qr) => {
                clearTimeout(timeout);
                try {
                    const qrBase64 = await QRCode.toDataURL(qr);
                    resolve({ status: 'qr_ready', qr: qrBase64 });
                } catch (err) {
                    reject(err);
                }
            }).catch(reject);
        });

        res.json(result);
    } catch (error: any) {
        logger.error(`Error starting session for ${userId}: ${error.message}`);
        res.status(500).json({ error: 'Failed to start session' });
    }
};

export const getSessionStatus = async (req: Request, res: Response) => {
    const { userId } = req.params;
    
    if (!userId) {
        return res.status(400).json({ error: 'userId is required' });
    }

    try {
        const { rows } = await pool.query(
            `SELECT session_status, whatsapp_number, updated_at FROM users_whatsapp_sessions WHERE user_id = $1`,
            [userId]
        );
        
        if (rows.length === 0) {
            return res.json({ status: 'not_found', connectedNumber: null });
        }

        const sock = sessions.get(userId);
        const isMemoryActive = !!sock;
        const dbStatus = rows[0].session_status;

        // Prefer live socket number (most up-to-date), fall back to DB record
        // Baileys stores user id as "<number>:<device>@s.whatsapp.net"
        const rawLiveNumber = sock?.user?.id?.split(':')[0] ?? null;
        const rawDbNumber   = rows[0].whatsapp_number ?? null;
        const rawNumber     = rawLiveNumber || rawDbNumber;

        // Format as +<number> for consistency on the client
        const connectedNumber = rawNumber
            ? (rawNumber.startsWith('+') ? rawNumber : `+${rawNumber}`)
            : null;
        
        res.json({
            status: isMemoryActive ? 'CONNECTED' : dbStatus,
            connectedNumber
        });
    } catch (error: any) {
        res.status(500).json({ error: 'Failed to retrieve session status' });
    }
};

export const sendPdf = async (req: Request, res: Response) => {
    const { userId, targetNumber, pdfUrl, pdfBase64, caption, fileName, mimetype, url, base64 } = req.body;
    
    if (!userId || !targetNumber) {
        return res.status(400).json({ error: 'userId and targetNumber are required' });
    }
    
    const finalUrl = pdfUrl || url;
    const finalBase64 = pdfBase64 || base64;

    if (!finalUrl && !finalBase64) {
        return res.status(400).json({ error: 'Either pdfUrl/url or pdfBase64/base64 must be provided' });
    }

    try {
        const jobId = await addPdfJobToQueue(userId, targetNumber, finalUrl, finalBase64, caption, fileName, mimetype);
        res.json({ status: 'queued', jobId });
    } catch (error: any) {
        res.status(500).json({ error: 'Failed to queue document for sending' });
    }
};

export const sendDocument = sendPdf;

export const getGroups = async (req: Request, res: Response) => {
    const { userId } = req.params;

    if (!userId) {
        return res.status(400).json({ error: 'userId is required' });
    }

    try {
        const sock = sessions.get(userId);
        if (!sock) {
            return res.status(400).json({ error: 'WhatsApp session not connected for this user.' });
        }

        // Fetch all participating groups
        const groups = await sock.groupFetchAllParticipating();
        
        // Map to a cleaner array format for the frontend
        const groupList = Object.values(groups).map((group: any) => ({
            id: group.id,
            name: group.subject || 'Unnamed Group',
        }));

        res.json({ status: 'success', groups: groupList });
    } catch (error: any) {
        logger.error(`Error fetching groups for ${userId}: ${error.message}`);
        res.status(500).json({ error: 'Failed to fetch WhatsApp groups' });
    }
};

export const excelWhatsapp = async (req: Request, res: Response) => {
    try {
        const { userId } = req.body;
        const file = req.file;

        if (!userId) {
            return res.status(400).json({ error: 'userId is required' });
        }

        if (!file) {
            return res.status(400).json({ error: 'Excel file is required' });
        }

        const sock = sessions.get(userId);
        if (!sock) {
            return res.status(400).json({ error: 'WhatsApp session not connected for this user.' });
        }

        const workbook = xlsx.read(file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        
        // header: 1 returns 2D array, which makes it easy to work with row/column indices
        const data: any[][] = xlsx.utils.sheet_to_json(worksheet, { header: 1 });

        // Skip the first row (header) by starting loop from 1
        let messagesSent = 0;
        let errors = [];

        for (let i = 1; i < data.length; i++) {
            const row = data[i];
            
            // Columns are 0-indexed: col A -> index 0 (Phone Number), col B -> index 1 (Message)
            if (!row || row.length < 2) continue;

            const rawPhoneNumber = row[0]?.toString().trim();
            const message = row[1]?.toString().trim();

            if (!rawPhoneNumber || !message) continue;

            // Add +91 to phone number if it doesn't have it, but for baileys we just need 91 without the +
            let targetNumber = rawPhoneNumber;
            
            // Clean non-digit characters just in case, but keep the + if present initially
            const cleanNumber = targetNumber.replace(/\D/g, '');
            
            if (cleanNumber.length === 10) {
                targetNumber = `91${cleanNumber}`;
            } else if (cleanNumber.startsWith('91') && cleanNumber.length === 12) {
                targetNumber = cleanNumber;
            } else {
                targetNumber = cleanNumber; // Fallback
            }

            const jid = `${targetNumber}@s.whatsapp.net`;

            try {
                // Generate token valid until 31 July 2026
                const expirationDate = Math.floor(new Date('2026-07-31T23:59:59Z').getTime() / 1000);
                
                // Encrypt payload to make URL opaque and secure
                const secretKey = crypto.createHash('sha256').update(process.env.JWT_SECRET || 'jF3HbDUuYfxfUjeDJRVg').digest();
                const iv = crypto.randomBytes(16);
                const cipher = crypto.createCipheriv('aes-256-cbc', secretKey, iv);
                
                const payload = `${cleanNumber}|${expirationDate}`;
                let encrypted = cipher.update(payload, 'utf8', 'hex');
                encrypted += cipher.final('hex');
                
                // Format: iv_encrypted
                const token = `${iv.toString('hex')}_${encrypted}`;

                // Ensure there is no trailing slash on the base URL to avoid double-slashes in the link
                const rawBaseUrl = process.env.BACKEND_API_URL || 'http://localhost:5001';
                const baseUrl = rawBaseUrl.replace(/\/+$/, '');
                const uploadLink = `${baseUrl}/api/v1/whatsapp-upload/form?token=${token}`;
                
                // Replace [Link] if it exists, otherwise append to bottom
                let finalMessage = message;
                if (message.includes('[Link]')) {
                    finalMessage = message.replace('[Link]', uploadLink);
                } else {
                    finalMessage = `${message}\n\nUpload your document here: ${uploadLink}`;
                }

                await addExcelMessageJobToQueue(userId, jid, finalMessage);
                messagesSent++;
                
            } catch (err: any) {
                logger.error(`Error queuing message for ${targetNumber}: ${err.message}`);
                errors.push({ number: targetNumber, error: err.message });
            }
        }

        res.json({ 
            status: 'success', 
            message: `Processed excel file. Queued ${messagesSent} messages for background sending.`,
            errors: errors.length > 0 ? errors : undefined
        });

    } catch (error: any) {
        logger.error(`Error in excelWhatsapp: ${error.message}`);
        res.status(500).json({ error: 'Failed to process excel file' });
    }
};

export const sendTextMessage = async (req: Request, res: Response) => {
    const { userId, targetNumber, message } = req.body;
    
    if (!userId || !targetNumber || !message) {
        return res.status(400).json({ error: 'userId, targetNumber, and message are required' });
    }

    const sock = sessions.get(userId);
    if (!sock) {
        return res.status(400).json({ error: 'WhatsApp session not connected for this user.' });
    }

    try {
        let formattedNumber = targetNumber.toString().trim();
        const cleanNumber = formattedNumber.replace(/\D/g, '');
        if (cleanNumber.length === 10) {
            formattedNumber = `91${cleanNumber}`;
        } else if (cleanNumber.startsWith('91') && cleanNumber.length === 12) {
            formattedNumber = cleanNumber;
        } else {
            formattedNumber = cleanNumber;
        }

        const jobId = await addExcelMessageJobToQueue(userId, formattedNumber, message.trim());
        res.json({ status: 'queued', jobId });
    } catch (error: any) {
        logger.error(`Error queuing text message for ${userId}: ${error.message}`);
        res.status(500).json({ error: 'Failed to queue text message' });
    }
};

