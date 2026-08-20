import { Router } from 'express';
import multer from 'multer';
import { startSession, getSessionStatus, sendPdf, sendTextMessage, getGroups, excelWhatsapp, logoutUserSession } from '../controllers/whatsappController';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// Routes
router.post(
    '/session/start',
    startSession
);
router.get(
    '/session/status/:userId',
    getSessionStatus
);
router.post(
    '/session/logout',
    logoutUserSession
);
router.post(
    '/messages/send-pdf',
    sendPdf
);
router.post(
    '/messages/send-text',
    sendTextMessage
);
router.get(
    '/groups/:userId',
    getGroups
);
router.post(
    '/excel',
    upload.single('file'),
    excelWhatsapp
);

export default router;

