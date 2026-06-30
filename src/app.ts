import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config/env';
import { logger } from './utils/logger';
import { apiKeyMiddleware } from './api/middlewares/auth';
import whatsappRoutes from './api/routes/whatsappRoutes';
import { autoReconnectSessions } from './services/whatsapp/sessionManager';
import { setupWorker } from './queue/worker';
import { initDb } from './database/connection';

const app = express();

// Middlewares
app.use(helmet());
app.use(cors({
    origin: config.allowedOrigins.includes('*') ? '*' : config.allowedOrigins,
    credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Log all incoming requests
app.use((req, res, next) => {
    logger.info(`Incoming Request: [${req.method}] ${req.url}`);
    next();
});

// Global API Key Auth
app.use('/api', apiKeyMiddleware);

// Routes
app.use('/api/whatsapp', whatsappRoutes);

// Health Check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', message: 'WhatsApp Service is running' });
});

// Start Server
app.listen(config.port, async () => {
    logger.info(`Server is running on port ${config.port} in ${config.env} mode`);
    
    // Ensure DB tables are ready first
    await initDb();
    
    // Auto-reconnect stored sessions
    await autoReconnectSessions();
    
    // Setup BullMQ worker for background jobs
    setupWorker();
});

export default app;
