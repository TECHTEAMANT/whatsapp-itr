import { Pool } from 'pg';
import { config } from '../config/env';
import { logger } from '../utils/logger';

export const pool = new Pool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.name,
});

pool.on('error', (err) => {
    logger.error(err, 'Unexpected error on idle client');
    process.exit(-1);
});

// We can remove the loose pool.connect test since initDb will handle testing the connection.
export const initDb = async () => {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS users_whatsapp_sessions (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(255) UNIQUE NOT NULL,
                whatsapp_number VARCHAR(100),
                session_status VARCHAR(50) DEFAULT 'DISCONNECTED',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS message_logs (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(255) NOT NULL,
                target_number VARCHAR(100) NOT NULL,
                message_type VARCHAR(50),
                status VARCHAR(50),
                error_message TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        logger.info('Database tables initialized');
    } catch (err: any) {
        logger.error(err, 'Error initializing DB tables');
        throw err;
    } finally {
        client.release();
    }
};
