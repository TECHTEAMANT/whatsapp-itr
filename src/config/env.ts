import dotenv from 'dotenv';

dotenv.config();

export const config = {
    env: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT || '3000', 10),
    apiKey: process.env.API_KEY || 'development_secret',
    allowedOrigins: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['*'],
    db: {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        user: process.env.DB_USER || 'wa_user',
        password: process.env.DB_PASSWORD || 'wa_pass',
        name: process.env.DB_NAME || 'whatsapp_db'
    },
    redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10)
    },
    backend: {
        devUrl: (process.env.BACKEND_API_URL_DEV || 'https://apis-dev.accountsntax.com').replace(/\/+$/, ''),
        prodUrl: (process.env.BACKEND_API_URL_PROD || 'https://apis.accountsntax.com').replace(/\/+$/, ''),
        defaultUrl: (process.env.BACKEND_API_URL || 'https://apis-dev.accountsntax.com').replace(/\/+$/, '')
    },
    backendApiUrl: (process.env.BACKEND_API_URL || '').replace(/\/+$/, ''),
    backendCallbackToken: process.env.BACKEND_CALLBACK_TOKEN || process.env.WHATSAPP_QR_CALLBACK_TOKEN || ''
};

