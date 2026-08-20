export const isWhatsAppJid = (value: string): boolean => {
    const raw = String(value || '').trim();
    return raw.includes('@g.us') || raw.includes('@s.whatsapp.net') || raw.includes('@lid');
};

export const formatTargetNumber = (targetNumber: string): string => {
    const formatted = String(targetNumber || '').trim();
    if (!formatted) {
        return '';
    }
    if (isWhatsAppJid(formatted)) {
        return formatted;
    }

    const cleanNumber = formatted.replace(/\D/g, '');
    if (cleanNumber.length === 10) {
        return `91${cleanNumber}`;
    }
    if (cleanNumber.startsWith('91') && cleanNumber.length === 12) {
        return cleanNumber;
    }
    return cleanNumber;
};
