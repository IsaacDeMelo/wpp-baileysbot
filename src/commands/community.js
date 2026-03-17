async function handleCommunityCommands(ctx) {
    const {
        command,
        args,
        argText,
        msg,
        jid,
        sock,
        isMaster,
        isGroup,
        isDev,
        isAdmin,
        cleanSender,
        cleanID,
        groupName,
        moment,
        Community,
        GroupConfig,
        getCommunityStats,
        downloadMedia,
        downloadContentFromMessage,
        cloudinary
    } = ctx;

    if (command !== '!comunidade' && command !== '!comunidades') return false;

    const subCommand = args[0]?.toLowerCase();

    if (subCommand === 'criar') {
        if (!isMaster) return true;
        const params = argText.replace(/^criar\s+/i, '').split('|').map(a => a.trim());
        if (params.length < 2) {
            await sock.sendMessage(jid, { text: '🎓. Use: !comunidade criar Nome | Descrição (e reaja a uma imagem)' });
            return true;
        }

        const media = await downloadMedia(msg, downloadContentFromMessage);
        let imgUrl = null;
        if (media && media.type === 'image') {
            const upload = await new Promise((resolve) => {
                cloudinary.uploader.upload_stream({ resource_type: 'image' }, (err, res) => resolve(res)).end(media.buffer);
            });
            imgUrl = upload?.secure_url;
        }

        try {
            await Community.create({ name: params[0], description: params[1], creatorJid: cleanSender, imageUrl: imgUrl });
            await sock.sendMessage(jid, { text: `🧩| Comunidade *${params[0]}* foi criada!\n* Use !comunidade addgp para adicionar grupos.` });
        } catch (e) {
            if (e?.code === 11000) {
                await sock.sendMessage(jid, { text: '💜. Nome de comunidade já existe.' });
            } else {
                console.error('Erro ao criar comunidade:', e);
                await sock.sendMessage(jid, { text: '🌤️. Não consegui criar a comunidade agora. Tente novamente.' });
            }
        }
        return true;
    }

    if (subCommand === 'addgp') {
        if (!isGroup) {
            await sock.sendMessage(jid, { text: '🎓. Use este comando dentro de um grupo.' });
            return true;
        }

        const commName = argText.replace(/^addgp\s+/i, '').trim();
        if (!commName) {
            await sock.sendMessage(jid, { text: '🎓. Use: !comunidade addgp NomeDaComunidade' });
            return true;
        }

        const comm = await Community.findOne({ name: commName });
        if (!comm) {
            await sock.sendMessage(jid, { text: '🌤️. Comunidade não encontrada.' });
            return true;
        }
        if (comm.creatorJid !== cleanSender && !isDev) {
            await sock.sendMessage(jid, { text: '💜. Apenas o criador da comunidade.' });
            return true;
        }

        const currentCfg = await GroupConfig.findOne({ jid });
        const previousCommName = currentCfg?.communityName;
        if (previousCommName && previousCommName !== commName) {
            await Community.updateOne({ name: previousCommName }, { $pull: { groups: jid } });
        }

        await Community.updateOne({ name: commName }, { $addToSet: { groups: jid } });
        await GroupConfig.findOneAndUpdate({ jid }, { communityName: commName }, { upsert: true });

        await sock.sendMessage(jid, { text: `🧩| O grupo *${groupName}* foi adicionado na comunidade *${commName}*!\n* Dados compartilhados com sucesso! 💜` });
        return true;
    }

    if (subCommand === 'rmvgp') {
        if (!isGroup) {
            await sock.sendMessage(jid, { text: '🎓. Use este comando dentro de um grupo.' });
            return true;
        }

        const gConf = await GroupConfig.findOne({ jid });
        if (!gConf?.communityName) {
            await sock.sendMessage(jid, { text: '🌤️. Este grupo não pertence a nenhuma comunidade.' });
            return true;
        }

        const commName = gConf.communityName;
        const comm = await Community.findOne({ name: commName });
        const canManage = isDev || isAdmin || (comm && comm.creatorJid === cleanSender);
        if (!canManage) {
            await sock.sendMessage(jid, { text: '💜. Apenas admin do grupo, Dev ou criador da comunidade.' });
            return true;
        }

        await Community.updateOne({ name: commName }, { $pull: { groups: jid } });
        await GroupConfig.updateOne({ jid }, { $set: { communityName: null } });

        await sock.sendMessage(jid, { text: `🧩| O grupo *${groupName}* foi removido da comunidade *${commName}*! 💔` });
        return true;
    }

    if (subCommand === 'capa') {
        const commName = argText.replace(/^capa\s+/i, '').trim();
        if (!commName) {
            await sock.sendMessage(jid, { text: '🎓. Use: !comunidade capa NomeDaComunidade (marcando/enviando imagem)' });
            return true;
        }

        const comm = await Community.findOne({ name: commName });
        if (!comm) {
            await sock.sendMessage(jid, { text: '🌤️. Comunidade não encontrada.' });
            return true;
        }
        if (comm.creatorJid !== cleanSender && !isDev) {
            await sock.sendMessage(jid, { text: '💜. Apenas o criador da comunidade ou Dev pode alterar a capa.' });
            return true;
        }

        const media = await downloadMedia(msg, downloadContentFromMessage);
        const isImageFile = media && (media.type === 'image' || (media.type === 'document' && media.mimetype && media.mimetype.startsWith('image/')));
        if (!isImageFile) {
            await sock.sendMessage(jid, { text: '🎓. Marque ou envie uma imagem com a legenda: !comunidade capa NomeDaComunidade' });
            return true;
        }

        const upload = await new Promise((resolve) => {
            cloudinary.uploader.upload_stream({ resource_type: 'image', folder: 'communities' }, (err, res) => {
                if (err) return resolve(null);
                resolve(res);
            }).end(media.buffer);
        });

        const imageUrl = String(upload?.secure_url || upload?.url || '').trim();
        if (!imageUrl) {
            await sock.sendMessage(jid, { text: '🌤️. Não consegui enviar a imagem da capa.' });
            return true;
        }

        await Community.updateOne({ name: commName }, { $set: { imageUrl } });
        await sock.sendMessage(jid, { text: `🖼️. Capa da comunidade *${commName}* atualizada com sucesso.` });
        return true;
    }

    if (subCommand === 'apagar') {
        const commName = argText.replace(/^apagar\s+/i, '').trim();
        if (!commName) {
            await sock.sendMessage(jid, { text: '🎓. Use: !comunidade apagar NomeDaComunidade' });
            return true;
        }

        const comm = await Community.findOne({ name: commName });
        if (!comm) {
            await sock.sendMessage(jid, { text: '🌤️. Comunidade não encontrada.' });
            return true;
        }
        if (comm.creatorJid !== cleanSender && !isDev) {
            await sock.sendMessage(jid, { text: '💜. Apenas o criador da comunidade ou Dev pode apagar.' });
            return true;
        }

        await Community.deleteOne({ name: commName });
        await GroupConfig.updateMany({ communityName: commName }, { $set: { communityName: null } });
        await sock.sendMessage(jid, { text: `🗑️. Comunidade *${commName}* apagada. Vínculos dos grupos foram limpos.` });
        return true;
    }

    if (command === '!comunidades') {
        if (!isMaster) return true;
        const comms = await Community.find();
        let txt = `🧩| *COMUNIDADES GLOBAIS*\n> 📅 ${moment().format('DD/MM/YYYY [às] HH:mm')}\n\n`;
        for (const c of comms) {
            const stats = getCommunityStats(c);
            txt += `* Comunidade: ${c.name}\n`;
            txt += `* Criada por: @${cleanID(c.creatorJid)}\n`;
            txt += `* Grupos: ${c.groups.length}\n`;
            txt += `* Atividade Semanal: ${stats.currentWeek} msgs\n\n`;
        }
        await sock.sendMessage(jid, { text: txt, mentions: comms.map(c => c.creatorJid) });
        return true;
    }

    const gConf = await GroupConfig.findOne({ jid });
    const searchName = args[0] || gConf?.communityName;
    if (!searchName) {
        await sock.sendMessage(jid, { text: '🎓. Especifique a comunidade ou adicione este grupo a uma.' });
        return true;
    }

    const comm = await Community.findOne({ name: searchName });
    if (!comm) {
        await sock.sendMessage(jid, { text: '🌤️. Comunidade não encontrada.' });
        return true;
    }

    const stats = getCommunityStats(comm);
    const groupsData = await GroupConfig.find({ jid: { $in: comm.groups } }).lean();
    const groupsByJid = new Map((groupsData || []).map(g => [g.jid, g]));

    const totalGroups = comm.groups.length;
    const variation = stats.lastWeek > 0
        ? ((stats.currentWeek - stats.lastWeek) / stats.lastWeek * 100).toFixed(1)
        : (stats.currentWeek > 0 ? '+100' : '0');
    const variationStr = stats.lastWeek > 0
        ? `${stats.currentWeek >= stats.lastWeek ? '+' : ''}${variation}%`
        : (stats.currentWeek > 0 ? '+100%' : '0%');

    let report = `🧩| *COMUNIDADE ${comm.name.toUpperCase()}*\n`;
    report += `> 📅 Criada em: ${moment(comm.createdAt).format('DD/MM/YYYY [às] HH:mm')}\n`;
    report += `> 👤 Por: ${comm.creatorJid === cleanSender ? 'Você' : '@' + cleanID(comm.creatorJid)}\n`;
    if (comm.description) report += `> 📝 ${comm.description}\n`;
    report += `\n`;

    report += `📊| *INFORMAÇÕES*\n`;
    report += `* Total de Grupos: ${totalGroups}\n`;
    report += `* Msgs Esta Semana: ${stats.currentWeek}\n`;
    report += `* Msgs Semana Anterior: ${stats.lastWeek}\n`;
    report += `* Variação: ${variationStr}\n\n`;

    report += `☕| *GRUPOS INTEGRANTES*\n`;
    if (!Array.isArray(comm.groups) || !comm.groups.length) {
        report += `• (sem grupos vinculados)\n`;
    } else {
        for (const gJid of comm.groups) {
            const g = groupsByJid.get(gJid);
            report += `• ${g?.nick || ('Grupo ' + cleanID(gJid))}\n`;
        }
    }

    const opt = { caption: report, mentions: [comm.creatorJid] };
    if (comm.imageUrl) opt.image = { url: comm.imageUrl };
    await sock.sendMessage(jid, opt);
    return true;
}

module.exports = { handleCommunityCommands };
