import { Request, Response } from 'express';
import { initSession, sessions } from '../../services/whatsapp/sessionManager';
import { addPdfJobToQueue } from '../../queue/producer';
import QRCode from 'qrcode';
import { logger } from '../../utils/logger';
import { pool } from '../../database/connection';

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
            return res.json({ status: 'not_found' });
        }

        const isMemoryActive = sessions.has(userId);
        const dbStatus = rows[0].session_status;
        
        res.json({
            status: isMemoryActive ? 'CONNECTED' : dbStatus,
            whatsappNumber: rows[0].whatsapp_number,
            lastUpdated: rows[0].updated_at
        });
    } catch (error: any) {
        res.status(500).json({ error: 'Failed to retrieve session status' });
    }
};

export const sendPdf = async (req: Request, res: Response) => {
    const { userId, targetNumber, pdfUrl, pdfBase64, caption, fileName } = req.body;
    
    if (!userId || !targetNumber) {
        return res.status(400).json({ error: 'userId and targetNumber are required' });
    }
    
    if (!pdfUrl && !pdfBase64) {
        return res.status(400).json({ error: 'Either pdfUrl or pdfBase64 must be provided' });
    }

    try {
        const jobId = await addPdfJobToQueue(userId, targetNumber, pdfUrl, pdfBase64, caption, fileName);
        res.json({ status: 'queued', jobId });
    } catch (error: any) {
        res.status(500).json({ error: 'Failed to queue PDF for sending' });
    }
};

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
