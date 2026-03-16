async function handleMailCommands(ctx) {
    const {
        command,
        args,
        argText,
        msg,
        jid,
        sock,
        user,
        groupName,
        cleanSender,
        isAdmin,
        isMaster,
        isDev,
        cleanID,
        moment,
        delay,
        jidNormalizedUser,
        getTarget,
        parseJidFromInput,
        downloadMedia,
        downloadContentFromMessage,
        GroupConfig,
        UserProfile,
        ID_GRUPO_DIRETORIA,
        ID_GRUPO_DENUNCIAS
    } = ctx;

    if (command === '!cadastrarmail') {
        user.isMailRegistered = true;
        await user.save();
        await sock.sendMessage(jid, { text: '📮| Registro concluído! Você agora possui autorização para utilizar o sistema de Mail Academy.' });
        return true;
    }

    if (command === '!cadastrargp') {
        if (!isAdmin && !isMaster) return true;
        const nick = args[0]?.toLowerCase();
        const desc = argText.replace(args[0], '').trim();
        if (!nick) {
            await sock.sendMessage(jid, { text: '🌤️. Use: !cadastrargp <nick> | <descrição>' });
            return true;
        }

        await GroupConfig.findOneAndUpdate(
            { jid },
            { nick, description: desc, mailRegistered: true },
            { upsert: true }
        );
        await sock.sendMessage(jid, { text: `📮| Este grupo foi registrado no sistema como: *${nick}*` });
        return true;
    }

    if (command === '!listgp') {
        if (!isMaster && !isDev) return true;
        const gps = await GroupConfig.find({ mailRegistered: true });
        let res = `📇| *LISTA DE GRUPOS CADASTRADOS*\n\n`;
        gps.forEach(g => {
            res += `🏛️ *${g.nick}* | ${g.description || 'Sem descrição'}\n> 📅 Desde: ${moment(g.createdAt).format('DD/MM/YYYY')}\n\n`;
        });
        await sock.sendMessage(jid, { text: res });
        return true;
    }

    if (command === '!criarlistmail') {
        if (!isMaster && !isDev) return true;
        const listName = args[0]?.toLowerCase();
        if (!listName) return true;

        const exists = user.mailLists.find(l => l.name === listName);
        if (exists) {
            await sock.sendMessage(jid, { text: '📮. Essa lista já existe.' });
            return true;
        }

        user.mailLists.push({ name: listName, targets: [] });
        await user.save();
        await sock.sendMessage(jid, { text: `📮| Lista de transmissão *${listName}* criada com sucesso.` });
        return true;
    }

    if (command === '!addmail') {
        if (!isMaster || args[0] !== 'list') return true;
        const params = argText.replace('list', '').split('|').map(a => a.trim());
        const listName = params[0]?.toLowerCase();
        const targets = params[1]?.split('/').map(t => t.trim());

        const listIdx = user.mailLists.findIndex(l => l.name === listName);
        if (listIdx === -1) {
            await sock.sendMessage(jid, { text: '📮. Lista não encontrada.' });
            return true;
        }

        for (const tRaw of (targets || [])) {
            if (!tRaw) continue;
            let formatted = '';
            if (tRaw.includes('@')) {
                formatted = jidNormalizedUser(tRaw);
            } else {
                const parsed = parseJidFromInput(tRaw);
                if (parsed) formatted = parsed;
                else formatted = tRaw.toLowerCase();
            }

            if (!user.mailLists[listIdx].targets.includes(formatted)) {
                user.mailLists[listIdx].targets.push(formatted);
            }
        }

        await user.save();
        await sock.sendMessage(jid, { text: `📮| Destinatários adicionados à lista *${listName}*.` });
        return true;
    }

    if (command === '!mail') {
        if (!user.isMailRegistered && !isDev) {
            await sock.sendMessage(jid, { text: '📮. Acesso Negado. Você precisa estar cadastrado no sistema (!cadastrarmail).' });
            return true;
        }

        const parts = argText.split('|').map(p => p.trim());
        if (parts.length < 2) {
            await sock.sendMessage(jid, { text: '📮. Formato: !mail <destino> <titulo> | <mensagem>' });
            return true;
        }

        const firstPart = parts[0].split(' ');
        const destination = firstPart[0].toLowerCase();
        let title = firstPart.slice(1).join(' ');
        const body = parts[1];

        if (!title) title = '(Sem Assunto)';

        const media = await downloadMedia(msg, downloadContentFromMessage);

        let finalTargets = [];

        if (destination === 'diretoria') {
            if (!isMaster) {
                await sock.sendMessage(jid, { text: '📮. Apenas Masters enviam mail à Diretoria.' });
                return true;
            }
            finalTargets.push(ID_GRUPO_DIRETORIA);
        }
        else if (destination === 'denuncia' || destination === 'denúncia') {
            finalTargets.push(ID_GRUPO_DENUNCIAS);
        }
        else if (destination === 'global') {
            if (!isDev) return true;
            const allGps = await GroupConfig.find({ mailRegistered: true });
            finalTargets = allGps.map(g => g.jid);
        }
        else if (destination.startsWith('+') || destination.includes('@') || destination.startsWith('wa.me/') || /^\d[\d().-]{7,}\d$/.test(destination)) {
            const parsed = parseJidFromInput(destination) || getTarget();
            if (parsed) finalTargets.push(parsed);
        }
        else {
            const gp = await GroupConfig.findOne({ nick: destination });
            if (gp) {
                if (!isDev) {
                    await sock.sendMessage(jid, { text: '📮. Apenas Diretores enviam mail para grupos específicos.' });
                    return true;
                }
                finalTargets.push(gp.jid);
            } else {
                const list = user.mailLists.find(l => l.name === destination);
                if (list) {
                    if (!isDev) return true;
                    for (const t of list.targets) {
                        if (!t) continue;
                        if (t.includes('@')) {
                            finalTargets.push(jidNormalizedUser(t));
                            continue;
                        }

                        const parsed = parseJidFromInput(t);
                        if (parsed) {
                            finalTargets.push(parsed);
                            continue;
                        }

                        const subGp = await GroupConfig.findOne({ nick: t });
                        if (subGp) finalTargets.push(subGp.jid);
                    }
                }
            }
        }

        if (finalTargets.length === 0) {
            await sock.sendMessage(jid, { text: '📮. Destino não identificado.' });
            return true;
        }

        await sock.sendMessage(jid, { text: `📮| Processando envio de Mail para ${finalTargets.length} destinatário(s)...` });

        const failedTargets = [];
        for (const target of finalTargets) {
            const formattedMsg = `📨. *MAIL ACADEMY SYSTEM*\n\n*Assunto:* ${title}\n*De:* ${user.name} (${user.rank})\n\n${body}\n\n_Procedimento Institucional Academy_ 🏛️`;

            try {
                if (media) {
                    const mediaType = media.type === 'sticker' ? 'image' : media.type;
                    await sock.sendMessage(target, { [mediaType]: media.buffer, caption: formattedMsg });
                } else {
                    await sock.sendMessage(target, { text: formattedMsg });
                }

                if (destination === 'denuncia') {
                    await sock.sendMessage(ID_GRUPO_DIRETORIA, { text: `🔔| *NOVA DENÚNCIA RECEBIDA*\nAssunto: ${title}\nRelator: @${cleanID(cleanSender)}`, mentions: [cleanSender] });
                }
            } catch (e) {
                console.error(`Erro ao enviar mail para ${target}:`, e && e.message ? e.message : e);
                failedTargets.push({ target, error: e && e.message ? e.message : String(e) });
            }
            await delay(3000);
        }

        if (failedTargets.length > 0) {
            let failReport = `⚠️. Falha no envio para ${failedTargets.length} destinatário(s):\n`;
            failedTargets.forEach(f => failReport += `- ${f.target}: ${f.error}\n`);
            await sock.sendMessage(jid, { text: '📮. Envio concluído com erros.' });
            await sock.sendMessage(jid, { text: failReport });
        } else {
            await sock.sendMessage(jid, { text: '💜. Mail enviado com sucesso.' });
        }
        return true;
    }

    if (command === '!listmailusers' || command === '!listusuariosmail') {
        if (!isMaster) {
            await sock.sendMessage(jid, { text: '️🎓. Acesso restrito a Masters e DEVS.' });
            return true;
        }

        const users = await UserProfile.find({ isMailRegistered: true });

        if (users.length === 0) {
            await sock.sendMessage(jid, { text: '📨| Não há usuários cadastrados no sistema de mail no momento.' });
            return true;
        }

        let report = `💜| *USUÁRIOS AUTORIZADOS - MAIL ACADEMY*\n`;
        report += `> Total de Remetentes: ${users.length}\n\n`;

        users.forEach((u, index) => {
            report += `${index + 1}. 👤 *${u.name}*\n`;
            report += `> ID: @${cleanID(u.jid)}\n`;
            report += `> Rank: ${u.rank}\n\n`;
        });

        report += `_Para revogar acessos, use o banco de dados._ 🏛️`;

        await sock.sendMessage(jid, {
            text: report,
            mentions: users.map(u => u.jid)
        });
        return true;
    }

    return false;
}

module.exports = { handleMailCommands };
