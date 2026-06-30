import { Router } from 'express';
import { startSession, getSessionStatus, sendPdf, getGroups } from '../controllers/whatsappController';

const router = Router();

// Routes
router.post('/session/start', startSession);
router.get('/session/status/:userId', getSessionStatus);
router.post('/messages/send-pdf', sendPdf);
router.get('/groups/:userId', getGroups);

export default router;
