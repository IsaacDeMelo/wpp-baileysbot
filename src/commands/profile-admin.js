async function handleProfileAdminCommands(ctx) {
    const {
        command,
        args,
        argText,
        msg,
        jid,
        sock,
        user,
        isDev,
        isMaster,
        cleanSender,
        cleanID,
        getTarget,
        getUser,
        parseJidFromInput,
        normalizePhoneDigits,
        downloadMedia,
        downloadContentFromMessage,
        cloudinary,
        Badge,
        UserProfile,
        NON_BOT_CARGOS_FILTER
    } = ctx;

    if (command === '!addcargo') {
        if (!isMaster) {
            await sock.sendMessage(jid, { text: '️🌤️. Apenas Masters podem atribuir cargos.' });
            return true;
        }

        const rankMatch = String(argText || '').match(/^\s*rank\s*[:=]\s*(membro|master|coord|dev)\s+(.+)$/i);
        if (rankMatch) {
            const rank = rankMatch[1].charAt(0).toUpperCase() + rankMatch[1].slice(1).toLowerCase();
            const cargoByRank = String(rankMatch[2] || '').trim();
            if (!cargoByRank) {
                await sock.sendMessage(jid, { text: '🎓. Use: !addcargo rank:Dev NomeDoCargo' });
                return true;
            }

            const result = await UserProfile.updateMany(
                { rank },
                { $addToSet: { cargos: cargoByRank } }
            );

            await sock.sendMessage(jid, {
                text: `🎓. Cargo *"${cargoByRank}"* atribuído para rank *${rank}*.\n` +
                    `• Usuários afetados: ${result.modifiedCount || 0}`
            });
            return true;
        }

        const msgRankMatch = String(argText || '').match(/^\s*#(\d+)\s+(.+)$/i);
        if (msgRankMatch) {
            const pos = Number(msgRankMatch[1] || 0);
            const cargoByMsgRank = String(msgRankMatch[2] || '').trim();
            if (!Number.isFinite(pos) || pos <= 0 || !cargoByMsgRank) {
                await sock.sendMessage(jid, { text: '🎓. Use: !addcargo #1 NomeDoCargo' });
                return true;
            }

            const ranked = await UserProfile.find(NON_BOT_CARGOS_FILTER)
                .sort({ totalMessageCount: -1, jid: 1 })
                .skip(pos - 1)
                .limit(1)
                .select('jid totalMessageCount')
                .lean();

            if (!ranked.length || !ranked[0]?.jid) {
                await sock.sendMessage(jid, { text: `❌ Não encontrei usuário na posição #${pos} do rank de mensagens.` });
                return true;
            }

            const targetByRank = String(ranked[0].jid);
            const tUserByRank = await getUser(targetByRank);
            if (!Array.isArray(tUserByRank.cargos)) tUserByRank.cargos = [];
            if (!tUserByRank.cargos.some(c => String(c).toLowerCase() === cargoByMsgRank.toLowerCase())) {
                tUserByRank.cargos.push(cargoByMsgRank);
                await tUserByRank.save();
            }

            await sock.sendMessage(jid, {
                text: `🎓. Cargo *"${cargoByMsgRank}"* atribuído ao usuário do rank *#${pos}* (@${cleanID(targetByRank)}).`,
                mentions: [targetByRank]
            });
            return true;
        }

        const target = getTarget();
        let cargo = (args || []).filter(a => !parseJidFromInput(a)).join(' ').trim();
        if (!cargo) {
            const targetDigits = normalizePhoneDigits(cleanID(target || ''));
            cargo = String(argText || '')
                .replace(/@\d+/g, '')
                .replace(targetDigits ? new RegExp(targetDigits, 'g') : /$^/, '')
                .trim();
        }

        if (!target || !cargo) {
            await sock.sendMessage(jid, {
                text: '🎓. Use:\n' +
                    '• !addcargo @usuario NomeDoCargo\n' +
                    '• !addcargo 5582999999999 NomeDoCargo\n' +
                    '• !addcargo rank:Dev NomeDoCargo'
            });
            return true;
        }

        const tUser = await getUser(target);
        if (!Array.isArray(tUser.cargos)) tUser.cargos = [];
        if (!tUser.cargos.some(c => String(c).toLowerCase() === cargo.toLowerCase())) {
            tUser.cargos.push(cargo);
            await tUser.save();
        }

        await sock.sendMessage(jid, {
            text: `🎓. Cargo *"${cargo}"* atribuído a @${cleanID(target)}`,
            mentions: [target]
        });
        return true;
    }

    if (command === '!rmcargo') {
        if (!isMaster) return true;
        const target = getTarget();
        if (!target) {
            await sock.sendMessage(jid, { text: '💜. Informe ou marque o usuário.' });
            return true;
        }

        const tUser = await getUser(target);
        const cargoToRemove = argText.replace(/@\d+/g, '').trim();

        if (cargoToRemove) {
            tUser.cargos = (tUser.cargos || []).filter(c => c.toLowerCase() !== cargoToRemove.toLowerCase());
            await tUser.save();
            await sock.sendMessage(jid, { text: `🗑. Cargo *"${cargoToRemove}"* removido de @${cleanID(target)}.`, mentions: [target] });
            return true;
        }

        tUser.cargos = [];
        await tUser.save();
        await sock.sendMessage(jid, { text: `🗑. Todos os cargos de @${cleanID(target)} foram removidos.`, mentions: [target] });
        return true;
    }

    if (command === '!addcargodefinitivo') {
        if (!isDev) {
            await sock.sendMessage(jid, { text: '🎓. Apenas Diretores podem definir cargo supremo.' });
            return true;
        }

        const target = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        const title = argText.replace(/@\d+/g, '').trim();
        if (!target || !title) {
            await sock.sendMessage(jid, { text: '🎓. Use: !addcargodefinitivo @usuario Titulo Supremo' });
            return true;
        }

        const tUser = await getUser(target);
        tUser.supremeTitle = title;
        await tUser.save();

        await sock.sendMessage(jid, {
            text: `🅰️. Cargo Supremo definido para @${cleanID(target)}: *${title}*`,
            mentions: [target]
        });
        return true;
    }

    if (command === '!img') {
        if (!isDev) {
            await sock.sendMessage(jid, { text: '🎓. Apenas DEVS podem criar honrarias.' });
            return true;
        }

        const media = await downloadMedia(msg, downloadContentFromMessage);
        const isImage = media && (media.type === 'image' || (media.type === 'document' && media.mimetype?.startsWith('image/')));

        if (!isImage || !media.buffer) {
            await sock.sendMessage(jid, { text: '🎓| Envie, marque ou responda uma imagem ou arquivo de imagem com: !img Nome | Valor' });
            return true;
        }

        const parts = argText.split('|').map(p => p.trim());
        const badgeName = parts[0];
        const value = Number(parts[1] || 0);

        if (!badgeName) {
            await sock.sendMessage(jid, { text: '🎓. Use: !img NomeDaHonraria | Valor' });
            return true;
        }

        await sock.sendMessage(jid, { text: '⏳. Fazendo upload e registrando honraria...' });

        try {
            const uploadResult = await new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                    { resource_type: 'image', folder: 'badges' },
                    (err, result) => {
                        if (err) reject(err);
                        else resolve(result);
                    }
                );
                stream.end(media.buffer);
            });

            if (!uploadResult?.secure_url) throw new Error('Upload falhou');

            const nameLower = badgeName.toLowerCase();
            const badge = await Badge.findOneAndUpdate(
                { nameLower },
                {
                    name: badgeName,
                    nameLower,
                    imageUrl: uploadResult.secure_url,
                    value: Number.isFinite(value) ? value : 0,
                    createdBy: user.name
                },
                { upsert: true, new: true }
            );

            await sock.sendMessage(jid, {
                image: { url: badge.imageUrl },
                caption: `🌟. Honraria registrada com sucesso!\n\n*Nome:* ${badge.name}\n*Valor:* ${badge.value}`
            });
        } catch (err) {
            console.error('Erro no comando !img:', err);
            await sock.sendMessage(jid, { text: '🌤️. Erro ao processar imagem ou salvar no banco.' });
        }
        return true;
    }

    if (command === '!addhonraria') {
        if (!isMaster) {
            await sock.sendMessage(jid, { text: '🎓. Apenas Masters podem atribuir honrarias.' });
            return true;
        }

        const target = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        const badgeName = argText.replace(/@\d+/g, '').trim();

        if (!target || !badgeName) {
            await sock.sendMessage(jid, { text: '🎓.Use: !addhonraria @usuario NomeDaHonraria' });
            return true;
        }

        const badge = await Badge.findOne({ nameLower: badgeName.toLowerCase() });
        if (!badge) {
            await sock.sendMessage(jid, { text: '🌤️. Honraria nao encontrada. Use !img para cadastrar.' });
            return true;
        }

        const tUser = await getUser(target);
        if (!Array.isArray(tUser.honors)) tUser.honors = [];

        const already = tUser.honors.find(h => h?.nameLower === badge.nameLower);
        if (already) {
            await sock.sendMessage(jid, { text: '️💜. O usuario ja possui essa honraria.' });
            return true;
        }

        tUser.honors.push({
            name: badge.name,
            nameLower: badge.nameLower,
            imageUrl: badge.imageUrl,
            value: badge.value,
            grantedBy: user.name
        });
        await tUser.save();

        await sock.sendMessage(jid, {
            text: `🏅. Honraria *${badge.name}* atribuida a @${cleanID(target)}.`,
            mentions: [target]
        });
        return true;
    }

    if (command === '!linkimg') {
        const media = await downloadMedia(msg, downloadContentFromMessage);
        if (!media || media.type !== 'image') {
            await sock.sendMessage(jid, { text: '🎓. Marque uma imagem.' });
            return true;
        }

        await sock.sendMessage(jid, { text: '⏳. Gerando link...' });

        cloudinary.uploader.upload_stream({ resource_type: 'image' }, async (err, result) => {
            if (err) return sock.sendMessage(jid, { text: '🌤️. Erro no upload.' });

            await sock.sendMessage(jid, {
                image: { url: result.secure_url },
                caption: `🔗. *Link Gerado:*\n${result.secure_url}`
            });
        }).end(media.buffer);
        return true;
    }

    if (command === '!nickname') {
        const target = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        const nick = argText.replace(/@\d+/g, '').trim();
        if (!nick) {
            await sock.sendMessage(jid, { text: '🎓. Use: !nickname NomeRPG' });
            return true;
        }

        if (target && target !== cleanSender && !isDev) {
            await sock.sendMessage(jid, { text: '🎓. Apenas Diretores podem definir o nickname de outra pessoa.' });
            return true;
        }

        const tUser = await getUser(target || cleanSender);
        tUser.nickname = nick;
        await tUser.save();
        await sock.sendMessage(jid, { text: '✒️. Nickname atualizado!' });
        return true;
    }

    if (command === '!bio') {
        const newBio = argText;
        if (!newBio) {
            await sock.sendMessage(jid, { text: '✒️. Escreva sua bio do perfil. \n| Ex: !bio Aluno Academy' });
            return true;
        }

        user.bio = newBio;
        await user.save();
        await sock.sendMessage(jid, { text: '️✒️. Biografia atualizada!' });
        return true;
    }

    if (command === '!background-img' || command === '!capa-img') {
        const media = await downloadMedia(msg, downloadContentFromMessage);
        const isImageFile = media && (media.type === 'image' || (media.type === 'document' && media.mimetype && media.mimetype.startsWith('image/')));
        if (!isImageFile) {
            await sock.sendMessage(jid, { text: '🎓. Marque ou envie uma imagem com a legenda !background-img' });
            return true;
        }

        await sock.sendMessage(jid, { text: '⏳. Atualizando capa...' });

        cloudinary.uploader.upload_stream({ resource_type: 'image' }, async (err, result) => {
            if (err) return sock.sendMessage(jid, { text: 'Erro no upload.' });

            user.backgroundUrl = result.secure_url;
            await user.save();

            await sock.sendMessage(jid, { text: '🎓. Capa do Perfil definida com sucesso!\nUse !perfil para ver.' });
        }).end(media.buffer);
        return true;
    }

    if (command === '!background') {
        if (!isDev) {
            await sock.sendMessage(jid, { text: '🎓. Apenas DEVS podem definir a cor de fundo.' });
            return true;
        }

        const color = argText.trim();
        if (!color) {
            await sock.sendMessage(jid, { text: '🎓. Use: !background <cor-css|hex> (ex: !background #112233)' });
            return true;
        }

        user.backgroundColor = color;
        await user.save();
        await sock.sendMessage(jid, { text: `🎨. Cor de fundo atualizada para: ${color}. Use !perfil para ver.` });
        return true;
    }

    if (command === '!perfilpic') {
        const sub = args[0]?.toLowerCase();
        if (sub === 'reset' || sub === 'remover') {
            user.avatar = '';
            await user.save();
            await sock.sendMessage(jid, { text: '📇. Foto de perfil personalizada removida. Voltando ao avatar padrão.' });
            try {
                await sock.sendMessage(cleanSender, { text: '📇. Seu avatar personalizado foi removido com sucesso. Use !perfil para ver.' });
            } catch {}
            return true;
        }

        const media = await downloadMedia(msg, downloadContentFromMessage);
        const isImageFile = media && (media.type === 'image' || (media.type === 'document' && media.mimetype && media.mimetype.startsWith('image/')));
        if (!isImageFile) {
            await sock.sendMessage(jid, { text: '📇. Marque ou envie uma imagem/arquivo de imagem com a legenda !perfilpic' });
            return true;
        }

        await sock.sendMessage(jid, { text: '⏳. Atualizando foto de perfil personalizada...' });

        cloudinary.uploader.upload_stream({ resource_type: 'image' }, async (err, result) => {
            if (err || !result?.secure_url) return sock.sendMessage(jid, { text: '🌤️. Erro ao enviar imagem.' });

            user.avatar = result.secure_url;
            await user.save();

            await sock.sendMessage(jid, { text: '🎓. Foto de perfil personalizada atualizada! Use !perfil para ver.' });
        }).end(media.buffer);
        return true;
    }

    return false;
}

module.exports = { handleProfileAdminCommands };
