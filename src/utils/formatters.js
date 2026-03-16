const moment = require('moment');

function getBrasiliaDateTimeParts(date = new Date()) {
    try {
        const fmt = new Intl.DateTimeFormat('pt-BR', {
            timeZone: 'America/Sao_Paulo',
            day: '2-digit',
            month: '2-digit',
            year: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });
        const parts = Object.fromEntries(fmt.formatToParts(date).map((part) => [part.type, part.value]));
        return {
            date: `${parts.day}/${parts.month}/${parts.year}`,
            time: `${parts.hour}:${parts.minute}`
        };
    } catch {
        return {
            date: moment(date).format('DD/MM/YY'),
            time: moment(date).format('HH:mm')
        };
    }
}

function pad2(n) {
    const value = Number(n);
    if (!Number.isFinite(value)) return String(n || '').padStart(2, '0');
    return String(value).padStart(2, '0');
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0';
    return new Intl.NumberFormat('pt-BR').format(n);
}

function formatMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0,00';
    return new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function bufferToDataUrl(buffer, mimeType) {
    if (!buffer) return '';
    const base64 = Buffer.from(buffer).toString('base64');
    return `data:${mimeType};base64,${base64}`;
}

module.exports = {
    getBrasiliaDateTimeParts,
    pad2,
    escapeHtml,
    formatNumber,
    formatMoney,
    bufferToDataUrl
};
