const moment = require('moment');
const { getBrasiliaDateTimeParts, pad2 } = require('./formatters');

function toOneLine(text, maxLen = 500) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function formatAdvPrivateNotice({
    id,
    reason,
    adminTag,
    adminDigits,
    location,
    statusCurrent,
    statusMax,
    finalLine
}) {
    const { date, time } = getBrasiliaDateTimeParts(new Date());
    return (
        `📕| AVISO DE ADVETÊNCIA\n` +
        `> Em: ${date} • ${time}\n\n` +
        `*🗒. ID:* ${id}\n` +
        `*🚨. Razão:* ${reason}\n\n` +
        `*✦.Por:* @${adminDigits}${adminTag ? ` (${toOneLine(adminTag, 60)})` : ''}\n` +
        `*╰ Local:* ${location}\n` +
        `*╰ Status:* ${pad2(statusCurrent)}/${pad2(statusMax)} Advertência/s\n` +
        `${finalLine}`
    );
}

function formatAdvCouncilReport({ id, reason, targetDigits, adminDigits, adminTag, location, statusCurrent, statusMax }) {
    const { date, time } = getBrasiliaDateTimeParts(new Date());
    return (
        `*📰. CINT REPORT • Advertência*\n` +
        `> Ocorrência: ${date} • ${time}\n\n` +
        `*✦. ID:* ${id}\n` +
        `*╰ Razão:* ${reason}\n` +
        `*╰ Infrator:* @${targetDigits}\n\n` +
        `*✦. Por:* @${adminDigits}${adminTag ? ` (${toOneLine(adminTag, 60)})` : ''}\n` +
        `*✦. Local:* ${location}\n` +
        `*✦. Status:* ${pad2(statusCurrent)}/${pad2(statusMax)} Advertência/s`
    );
}

function formatPenaltyAppealPrivateNotice({ targetDigits, removedId, originalReason, location, currentCount, adminName }) {
    const { date, time } = getBrasiliaDateTimeParts(new Date());
    return (
        `📘| RECURSO PENAL ACADEMY\n` +
        `> Em: ${date} • ${time}\n\n` +
        `⚖️. A sua advertência foi revogada/perdoada.\n` +
        `*✦. Removido:* ${removedId}\n` +
        `*╰ Razão Original:* ${originalReason}\n` +
        `*✦. Local:* ${location}\n` +
        `*╰ Status Atual:* ${currentCount} ADVs\n` +
        `> Ação Administrativa por: ${toOneLine(adminName, 80)}`
    );
}

function formatPenaltyAppealCouncilReport({ targetDigits, removedId, originalReason, location, currentCount, adminName, adminDigits }) {
    const { date, time } = getBrasiliaDateTimeParts(new Date());
    return (
        `*📰. CINT REPORT • Recurso*\n` +
        `> Em: ${date} • ${time}\n\n` +
        `⚖️. A advertência de @${targetDigits} foi revogada/perdoada.\n` +
        `*✦. Removido:* ${removedId}\n` +
        `*╰ Razão Original:* ${originalReason}\n` +
        `*✦. Local:* ${location}\n` +
        `*╰ Status Atual:* ${currentCount} ADVs\n` +
        `> Ação Administrativa por: ${toOneLine(adminName, 80)} (@${adminDigits})`
    );
}

function unwrapMessage(message) {
    let unwrapped = message;
    for (let i = 0; i < 5; i++) {
        if (!unwrapped) break;
        if (unwrapped.ephemeralMessage?.message) { unwrapped = unwrapped.ephemeralMessage.message; continue; }
        if (unwrapped.viewOnceMessageV2?.message) { unwrapped = unwrapped.viewOnceMessageV2.message; continue; }
        if (unwrapped.viewOnceMessage?.message) { unwrapped = unwrapped.viewOnceMessage.message; continue; }
        if (unwrapped.documentWithCaptionMessage?.message) { unwrapped = unwrapped.documentWithCaptionMessage.message; continue; }
        break;
    }
    return unwrapped || message;
}

function parseDuration(durationStr) {
    if (!durationStr) return null;
    const num = parseInt(durationStr);
    const unit = durationStr.replace(/\d/g, '').toLowerCase();
    if (isNaN(num)) return null;
    return moment().add(num, unit === 'm' ? 'minutes' : 'days').toDate();
}

function getCtxValue(ctx, rawPath) {
    const pathParts = String(rawPath || '')
        .trim()
        .split('.')
        .map((part) => part.trim())
        .filter(Boolean);

    let current = ctx;
    for (const part of pathParts) {
        if (current === null || current === undefined) return '';
        if (Array.isArray(current)) {
            const idx = Number(part);
            current = Number.isFinite(idx) ? current[idx] : undefined;
        } else {
            current = current[part];
        }
    }
    return (current === null || current === undefined) ? '' : String(current);
}

function renderTemplate(tpl, ctx) {
    const input = String(tpl || '');
    const renderDouble = input.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, raw) => getCtxValue(ctx, raw));
    return renderDouble.replace(/\{\s*([a-zA-Z0-9_.]+)\s*\}/g, (_, raw) => getCtxValue(ctx, raw));
}

module.exports = {
    toOneLine,
    formatAdvPrivateNotice,
    formatAdvCouncilReport,
    formatPenaltyAppealPrivateNotice,
    formatPenaltyAppealCouncilReport,
    unwrapMessage,
    parseDuration,
    getCtxValue,
    renderTemplate
};
