import { Router } from 'express';
import multer from 'multer';
import { startSession, getSessionStatus, sendPdf, getGroups, excelWhatsapp } from '../controllers/whatsappController';

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
    '/messages/send-pdf',
    sendPdf
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
