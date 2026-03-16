async function downloadMedia(msg, downloadContentFromMessage) {
    try {
        const type = Object.keys(msg.message)[0];
        let mediaMsg = msg.message[type];
        if (type === 'extendedTextMessage' && msg.message.extendedTextMessage.contextInfo.quotedMessage) {
            const quoted = msg.message.extendedTextMessage.contextInfo.quotedMessage;
            const qType = Object.keys(quoted)[0];
            if (qType === 'imageMessage' || qType === 'videoMessage' || qType === 'stickerMessage' || qType === 'documentMessage') {
                mediaMsg = quoted[qType];
                const stream = await downloadContentFromMessage(mediaMsg, qType.replace('Message', ''));
                let buffer = Buffer.from([]);
                for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                return { buffer, type: qType.replace('Message', ''), mimetype: mediaMsg.mimetype || null, filename: mediaMsg.fileName || mediaMsg.caption || '' };
            }
        }
        if (!mediaMsg || (!mediaMsg.url && !mediaMsg.directPath)) return null;

        const stream = await downloadContentFromMessage(mediaMsg, type.replace('Message', ''));
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        return { buffer, type: type.replace('Message', ''), mimetype: mediaMsg.mimetype || null, filename: mediaMsg.fileName || mediaMsg.caption || '' };
    } catch (e) {
        return null;
    }
}

module.exports = {
    downloadMedia
};
