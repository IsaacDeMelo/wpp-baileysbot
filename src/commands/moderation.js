async function handleModerationCommands(ctx) {
    const {
        command,
        args,
        argText,
        msg,
        jid,
        sock,
        user,
        groupName,
        senderNumber,
        cleanSender,
        isGroup,
        isAdmin,
        isSuperAdmin,
        isOwner,
        isDev,
        isMaster,
        cleanID,
        moment,
        delay,
        jidNormalizedUser,
        getTarget,
        getUser,
        parseJidFromInput,
        extractFirstJidFromText,
        jidToPhoneDigits,
        isOwnerIdentity,
        getBotIdentitySet,
        isSameIdentity,
        notifyDirector,
        getNextId,
        parseDuration,
        formatAdvPrivateNotice,
        formatAdvCouncilReport,
        formatPenaltyAppealPrivateNotice,
        formatPenaltyAppealCouncilReport,
        clearEmbargoFields,
        pad2,
        GroupConfig,
        Community,
        UserProfile
    } = ctx;

    if (command === '!kick') {
        if (!isGroup) {
            await sock.sendMessage(jid, { text: '🎓. O comando !kick só pode ser usado em grupos.' });
            return true;
        }

        if (!isAdmin && !isMaster) return true;

        const targetJid = getTarget();
        if (!targetJid) {
            await sock.sendMessage(jid, { text: '🎓. Você deve mencionar o usuário ou digitar o número dele.' });
            return true;
        }

        const normalizedTarget = jidNormalizedUser(targetJid);
        if (!normalizedTarget) {
            await sock.sendMessage(jid, { text: '❌ Não consegui identificar o alvo do kick.' });
            return true;
        }

        if (isSameIdentity(normalizedTarget, cleanSender)) {
            await sock.sendMessage(jid, { text: '⚠️ Você não pode expulsar a si mesmo.' });
            return true;
        }

        const botIds = getBotIdentitySet(sock);
        for (const botId of botIds) {
            if (isSameIdentity(normalizedTarget, botId)) {
                await sock.sendMessage(jid, { text: '⚠️ Eu não posso me expulsar.' });
                return true;
            }
        }

        if (isOwnerIdentity(normalizedTarget) || isOwnerIdentity(jidToPhoneDigits(normalizedTarget))) {
            await sock.sendMessage(jid, { text: '⚠️ Não posso expulsar um proprietário do sistema.' });
            return true;
        }

        const targetUser = await getUser(normalizedTarget);
        if (targetUser.isCanonized) {
            await sock.sendMessage(jid, { text: '> ☀️ Santos não podem sofrer punições.\n\n> Oráculo Academy 💜' });
            return true;
        }

        const gConf = await GroupConfig.findOne({ jid });

        if (gConf?.communityName) {
            const comm = await Community.findOne({ name: gConf.communityName });
            if (!comm?.groups?.length) {
                await sock.sendMessage(jid, { text: '❌ A comunidade vinculada a este grupo não foi encontrada corretamente.' });
                return true;
            }

            let removedCount = 0;
            const failedGroups = [];

            await sock.sendMessage(jid, {
                text: `🧩. Removendo @${cleanID(normalizedTarget)} de todos os grupos da comunidade *${comm.name}*...`,
                mentions: [normalizedTarget]
            });

            for (const gId of comm.groups) {
                try {
                    const meta = await sock.groupMetadata(gId);
                    const participants = Array.isArray(meta?.participants) ? meta.participants : [];
                    const targetParticipant = participants.find(p => isSameIdentity(p.id, normalizedTarget));
                    if (!targetParticipant) continue;

                    const botParticipant = participants.find(p => {
                        const participantId = jidNormalizedUser(p.id);
                        return botIds.has(participantId);
                    });
                    const botIsAdminInGroup = botParticipant && (botParticipant.admin === 'admin' || botParticipant.admin === 'superadmin');
                    if (!botIsAdminInGroup) {
                        failedGroups.push(meta?.subject || gId);
                        continue;
                    }

                    await sock.groupParticipantsUpdate(gId, [jidNormalizedUser(targetParticipant.id)], 'remove');
                    removedCount++;
                } catch (e) {
                    failedGroups.push(gId);
                }
            }

            if (removedCount === 0) {
                const detail = failedGroups.length ? `\nFalha em: ${failedGroups.slice(0, 5).join(', ')}` : '';
                await sock.sendMessage(jid, {
                    text: `❌ Não consegui remover @${cleanID(normalizedTarget)} da comunidade.${detail}`,
                    mentions: [normalizedTarget]
                });
                return true;
            }

            const failSummary = failedGroups.length ? `\n⚠️ Falhou em ${failedGroups.length} grupo(s).` : '';
            await sock.sendMessage(jid, {
                text: `🚪 @${cleanID(normalizedTarget)} foi removido de ${removedCount} grupo(s) da comunidade *${comm.name}*.${failSummary}`,
                mentions: [normalizedTarget]
            });
            return true;
        }

        const currentGroupMetadata = await sock.groupMetadata(jid);
        const currentParticipants = Array.isArray(currentGroupMetadata?.participants) ? currentGroupMetadata.participants : [];
        const targetParticipant = currentParticipants.find(p => isSameIdentity(p.id, normalizedTarget));
        if (!targetParticipant) {
            await sock.sendMessage(jid, { text: '⚠️ Esse usuário não está neste grupo.' });
            return true;
        }

        if (!isSuperAdmin) {
            await sock.sendMessage(jid, { text: '💜. Eu preciso ser Admin para expulsar.' });
            return true;
        }

        await sock.groupParticipantsUpdate(jid, [jidNormalizedUser(targetParticipant.id)], 'remove');
        await sock.sendMessage(jid, { text: `🚪 Removido: @${cleanID(targetParticipant.id)}`, mentions: [jidNormalizedUser(targetParticipant.id)] });
        return true;
    }

    if (command === '!adv') {
        if (!isMaster) {
            await sock.sendMessage(jid, { text: '🎓. Acesso restrito a Masters e Diretores.' });
            return true;
        }

        const target = getTarget();
        if (!target) {
            await sock.sendMessage(jid, { text: '🎓| Mencione o usuário ou digite o número.\n| Ex: !adv @usuario | Motivo' });
            return true;
        }

        const tUser = await getUser(target);
        if (tUser.isCanonized) {
            await sock.sendMessage(jid, { text: '> ☀️ Santos não podem sofrer punições.\n\n> Academy Orácuoo 💜' }, { quoted: msg });
            return true;
        }

        const fullArgs = argText.split('|').map(a => a.trim());
        const isGlobal = args[0]?.toLowerCase() === 'global';
        const reason = (isGlobal ? fullArgs[1] : fullArgs[1]) || 'Sem motivo especificado';
        const adminName = user.name;
        const gConf = await GroupConfig.findOne({ jid });

        if (isGlobal) {
            const durationStr = fullArgs[2] || '30d';
            const id = getNextId(tUser.globalWarnings, 'ADVG');
            const endDate = parseDuration(durationStr);

            tUser.globalWarnings.push({ id, reason, admin: adminName, duration: durationStr, endDate });

            const pvTxtGlobal = formatAdvPrivateNotice({
                id,
                reason,
                adminTag: adminName,
                adminDigits: senderNumber,
                location: 'Rede Academy (Global)',
                statusCurrent: tUser.globalWarnings.length,
                statusMax: 5,
                finalLine: `> Com ${pad2(5)} ADVs, você poderá ser embargado.`
            });
            await sock.sendMessage(target, { text: pvTxtGlobal, mentions: [cleanSender] });

            await notifyDirector(sock, {
                text: formatAdvCouncilReport({
                    id,
                    reason,
                    targetDigits: cleanID(target),
                    adminDigits: senderNumber,
                    adminTag: adminName,
                    location: isGroup ? groupName : 'PV',
                    statusCurrent: tUser.globalWarnings.length,
                    statusMax: 5
                }),
                mentions: [target, cleanSender]
            });

            if (tUser.globalWarnings.length >= 5) {
                tUser.embargo = { active: true, reason: 'Acúmulo de 5 ADVs Globais', since: new Date(), admin: 'SYSTEM', duration: 'Permanente' };
                await sock.sendMessage(jid, { text: `*⚖️. EMBARGO ATIVADO*\nO usuário @${cleanID(target)} atingiu o limite de 5 advertências globais e foi banido da rede.`, mentions: [target] });
                if (isSuperAdmin) await sock.groupParticipantsUpdate(jid, [target], 'remove');

                await notifyDirector(sock, {
                    text:
                        `*⚖️. EMBARGO ATIVADO (AUTO)*\n` +
                        `Alvo: @${cleanID(target)}\n` +
                        `Motivo: Acúmulo de 5 ADVs Globais\n` +
                        `Por: SYSTEM (gatilho via ${adminName})\n` +
                        `Origem: ${isGroup ? `Grupo ${groupName}` : 'PV'} (${jid})\n` +
                        `Data: ${moment().format('DD/MM/YY HH:mm')}`,
                    mentions: [target]
                });
            } else {
                await sock.sendMessage(jid, {
                    text:
                        `*⚖️. ADV GLOBAL APLICADA* (em construção)\n` +
                        `Alvo: @${cleanID(target)}\n` +
                        `ID: ${id}\n` +
                        `Motivo: ${reason}\n` +
                        `Status: ${pad2(tUser.globalWarnings.length)}/${pad2(5)}\n` +
                        `Por: ${adminName}`,
                    mentions: [target]
                });
            }
        } else {
            const id = getNextId(tUser.localWarnings, 'ADV');
            tUser.localWarnings.push({ id, groupJid: jid, groupName, reason, admin: adminName });

            let localCount;
            let community = null;
            if (gConf?.communityName) {
                community = await Community.findOne({ name: gConf.communityName });
                localCount = tUser.localWarnings.filter(w => community.groups.includes(w.groupJid)).length;
            } else {
                localCount = tUser.localWarnings.filter(w => w.groupJid === jid).length;
            }

            const localName = community ? community.name : groupName;
            const pvTxtLocal = formatAdvPrivateNotice({
                id,
                reason,
                adminTag: adminName,
                adminDigits: senderNumber,
                location: localName,
                statusCurrent: localCount,
                statusMax: 3,
                finalLine: `> Com ${pad2(3)} ADVs, você será removido.`
            });
            await sock.sendMessage(target, { text: pvTxtLocal, mentions: [cleanSender] });

            await notifyDirector(sock, {
                text: formatAdvCouncilReport({
                    id,
                    reason,
                    targetDigits: cleanID(target),
                    adminDigits: senderNumber,
                    adminTag: adminName,
                    location: community ? community.name : groupName,
                    statusCurrent: localCount,
                    statusMax: 3
                }),
                mentions: [target, cleanSender]
            });

            if (localCount >= 3) {
                const banReason = community ? `Limite de ADVs na Comunidade ${community.name}` : 'Limite de ADVs no Grupo';

                await GroupConfig.findOneAndUpdate({ jid }, { $push: { autoBanList: { jid: target, reason: banReason, admin: 'SYSTEM' } } });

                if (community) {
                    await sock.sendMessage(jid, { text: `🎓. *EXPULSÃO COMUNITÁRIA*\nO usuário @${cleanID(target)} atingiu 3 advertências na comunidade *${community.name}* e será removido de todos os setores.`, mentions: [target] });
                    for (const gJid of community.groups) {
                        try { await sock.groupParticipantsUpdate(gJid, [target], 'remove'); } catch {}
                    }
                } else {
                    await sock.sendMessage(jid, { text: `🎓. *BANIMENTO POR ADVERTÊNCIA*\n@${cleanID(target)} atingiu 3 advertências e foi removido do grupo.`, mentions: [target] });
                    if (isSuperAdmin) await sock.groupParticipantsUpdate(jid, [target], 'remove');
                }
            } else {
                await sock.sendMessage(jid, {
                    text:
                        `📕| @${cleanID(target)} recebeu ${localCount}/3 advertências!\n` +
                        `Razão: ${reason}\n` +
                        `> Por: ${adminName}`,
                    mentions: [target]
                });
            }
        }

        await tUser.save();
        return true;
    }

    if (command === '!rmadv') {
        if (!isMaster) {
            await sock.sendMessage(jid, { text: '🎓. Acesso restrito a Masters e Superiores.' });
            return true;
        }

        const target = getTarget();
        if (!target) {
            await sock.sendMessage(jid, { text: '🎓| Mencione o usuário ou digite o número para remover a ADV.' });
            return true;
        }

        const tUser = await getUser(target);
        const gConf = await GroupConfig.findOne({ jid });
        const isGlobal = args[0]?.toLowerCase() === 'global';

        const parts = argText.split('|').map(p => p.trim());
        const specificId = parts.length > 1 ? parts[1].toUpperCase() : null;

        let removedAdv = null;
        let currentCount = 0;
        let contextName = '';
        let community = null;

        if (isGlobal) {
            contextName = 'Rede Academy (Global)';

            if (tUser.globalWarnings.length === 0) {
                await sock.sendMessage(jid, { text: '🎓| Este membro não possui Advertências Globais.' });
                return true;
            }

            if (specificId) {
                const index = tUser.globalWarnings.findIndex(w => w.id === specificId);
                if (index === -1) {
                    await sock.sendMessage(jid, { text: `🌤️. ID Global *${specificId}* não encontrado para este usuário.` });
                    return true;
                }
                removedAdv = tUser.globalWarnings.splice(index, 1)[0];
            } else {
                removedAdv = tUser.globalWarnings.pop();
            }

            currentCount = tUser.globalWarnings.length;

            if (tUser.embargo.active && tUser.embargo.reason.includes('5 ADVs') && currentCount < 5) {
                tUser.embargo.active = false;
                await sock.sendMessage(jid, { text: `⚖️ *EMBARGO REVOGADO*\nCom a remoção da ADV, @${cleanID(target)} saiu da zona de banimento automático.`, mentions: [target] });
            }
        } else {
            if (gConf?.communityName) {
                community = await Community.findOne({ name: gConf.communityName });
                contextName = `Comunidade ${community.name}`;
            } else {
                contextName = `Grupo ${groupName}`;
            }

            if (tUser.localWarnings.length === 0) {
                await sock.sendMessage(jid, { text: '🎓| Este membro não possui Advertências Locais.' });
                return true;
            }

            if (specificId) {
                const index = tUser.localWarnings.findIndex(w => w.id === specificId);
                if (index === -1) {
                    await sock.sendMessage(jid, { text: `🌤️. ID Local *${specificId}* não encontrado.` });
                    return true;
                }
                removedAdv = tUser.localWarnings.splice(index, 1)[0];
            } else {
                let indexToRemove = -1;
                for (let i = tUser.localWarnings.length - 1; i >= 0; i--) {
                    const w = tUser.localWarnings[i];
                    const belongsToContext = community ? community.groups.includes(w.groupJid) : w.groupJid === jid;
                    if (belongsToContext) {
                        indexToRemove = i;
                        break;
                    }
                }
                if (indexToRemove === -1) {
                    await sock.sendMessage(jid, { text: '🔎. Nenhuma advertência encontrada neste contexto para remover.' });
                    return true;
                }
                removedAdv = tUser.localWarnings.splice(indexToRemove, 1)[0];
            }

            if (community) {
                currentCount = tUser.localWarnings.filter(w => community.groups.includes(w.groupJid)).length;
            } else {
                currentCount = tUser.localWarnings.filter(w => w.groupJid === jid).length;
            }
        }

        await tUser.save();

        const locationPv = isGlobal ? 'Rede Academy (Global)' : (contextName.startsWith('Grupo ') ? groupName : contextName.replace(/^Comunidade\s+/i, ''));
        const msgPv = formatPenaltyAppealPrivateNotice({
            targetDigits: cleanID(target),
            removedId: removedAdv.id,
            originalReason: removedAdv.reason,
            location: locationPv,
            currentCount,
            adminName: user.name
        });
        try { await sock.sendMessage(target, { text: msgPv }); } catch {}

        const locationCouncil = isGlobal ? 'Rede Academy (Global)' : (gConf?.communityName ? (contextName.replace(/^Comunidade\s+/i, '')) : groupName);
        await notifyDirector(sock, {
            text: formatPenaltyAppealCouncilReport({
                targetDigits: cleanID(target),
                removedId: removedAdv.id,
                originalReason: removedAdv.reason,
                location: locationCouncil,
                currentCount,
                adminName: user.name,
                adminDigits: senderNumber
            }),
            mentions: [target]
        });

        await sock.sendMessage(jid, { text: `⚖️| INDULGÊNCIA: A ${removedAdv.id} foi removida de @${cleanID(target)}.\n> Um Informe foi enviado ao Conselho de Integridade e ao Privado do membro.`, mentions: [target] });

        if (!isGlobal && currentCount < 3) {
            const wasBanned = gConf?.autoBanList.find(b => b.jid === target && b.reason.includes('Limite de ADVs'));
            if (wasBanned) {
                await GroupConfig.findOneAndUpdate(
                    { jid },
                    { $pull: { autoBanList: { jid: target } } }
                );
                await sock.sendMessage(jid, { text: `🔓 @${cleanID(target)} foi removido do Auto-Ban pois suas ADVs caíram para menos de 3.`, mentions: [target] });
            }
        }

        return true;
    }

    if (command === '!listadv' || command === '!listaadv') {
        const targetArg = args[0] === 'global' ? args[1] : args[0];
        const mentionedJid = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        const targetJid = mentionedJid ? mentionedJid : (targetArg ? targetArg.replace(/\D/g, '') + '@s.whatsapp.net' : cleanSender);

        const tUser = await getUser(targetJid);

        if (args[0] === 'global') {
            let txt = `「🗃️ ≡ Seção de Advertências Globais (@${cleanID(targetJid)})\n\n`;
            tUser.globalWarnings.forEach(w => {
                txt += `📋| ${w.id}\n- ${w.reason}\n> Em: ${moment(w.date).format('DD/MM/YY HH:mm')}\n> Tempo: ${w.duration}\n\n`;
            });
            txt += `\n「🗂️ ≡ Seção de Advertências Locais\n\n`;
            tUser.localWarnings.forEach(w => {
                txt += `🗒️| ${w.id}\n- ${w.reason}\n> Onde: ${w.groupName}\n> Em: ${moment(w.date).format('DD/MM/YY')}\n\n`;
            });
            await sock.sendMessage(jid, { text: txt, mentions: [targetJid] });
        } else {
            let txt = `🍻 Advertências Locais de @${cleanID(targetJid)}\n\n`;
            const localAdvs = tUser.localWarnings.filter(w => w.groupJid === jid);
            localAdvs.forEach(w => {
                txt += `🗒️| ${w.id}\n- ${w.reason}\n> Por: ${w.admin}\n> Em: ${moment(w.date).format('DD/MM/YY')}\n\n`;
            });
            if (localAdvs.length === 0) txt += 'Nenhuma advertência neste grupo.';
            await sock.sendMessage(jid, { text: txt, mentions: [targetJid] });
        }
        return true;
    }

    if (command === '!embargo') {
        if (!isDev) {
            await sock.sendMessage(jid, { text: '🅰️. Acesso restrito à Diretoria DEVS+.' });
            return true;
        }

        const action = args[0]?.toLowerCase();
        const now = moment();
        const gConf = await GroupConfig.findOne({ jid });

        if (action === 'add') {
            const params = argText.split('|').map(a => a.trim());
            const targetRaw = String(params[0] || '').replace(/^add\s+/i, '').trim();
            const target = parseJidFromInput(targetRaw) || extractFirstJidFromText(targetRaw) || null;

            if (!target || params.length < 4) {
                await sock.sendMessage(jid, { text: '🅰️. *ERRO DE SINTAXE*\nUse: !embargo add @user | motivo | tempo | link' });
                return true;
            }

            const reason = params[1];
            const duration = params[2];
            const link = params[3];
            const endDate = parseDuration(duration);

            const tUser = await getUser(target);
            if (tUser.isCanonized) {
                await sock.sendMessage(jid, { text: '> ☀️ Santos não podem sofrer punições.\n\n> Academy Oráculo 💜' });
                return true;
            }

            const stableJid = tUser.jid;
            await UserProfile.findOneAndUpdate({ jid: stableJid }, {
                $set: { embargo: { active: true, reason, link, duration, since: new Date(), admin: user.name, endDate } }
            });

            const msgPV = `*⚖️| EMBARGO INSTITUCIONAL ACADEMY*\n` +
                `> Envio: ${now.format('DD/MM/YY • HH:mm')}\n` +
                `> De: diretoria@mail.acdm\n\n` +
                `Caro(a) @${cleanID(target)},\n\n` +
                `O Instituto Academy de RPGistas, por determinação da Diretoria Academy (DEVS+), declara o **EMBARGO** de sua participação em todas as redes, espaços e plataformas associadas à Academy.\n\n` +
                `*JUSTIFICATIVA:*\n${reason}\n\n` +
                `*Registro Interno:* ${link}\n` +
                `*Tempo de Embargo:* ${duration}\n\n` +
                `Atenciosamente, DEVS+ 💜\n` +
                `_Diretoria de Desenvolvimento Academy_`;

            await sock.sendMessage(target, { text: msgPV, mentions: [target] });

            await notifyDirector(sock, {
                text:
                    `⚖️| *NOTIFICAÇÃO DE EMBARGO*\n` +
                    `Alvo: @${cleanID(target)}\n` +
                    `Motivo: ${reason}\n` +
                    `Tempo: ${duration}\n` +
                    `Registro: ${link}\n` +
                    `Admin: ${user.name} (@${senderNumber})\n` +
                    `Origem: ${isGroup ? `Grupo ${groupName}` : 'PV'} (${jid})\n` +
                    `Data: ${moment().format('DD/MM/YY HH:mm')}`,
                mentions: [target]
            });

            await sock.sendMessage(jid, { text: `⏳. *Varredura Academy Iniciada...* Localizando infrator e validando LIDs.` });

            if (gConf?.communityName) {
                try {
                    const comm = await Community.findOne({ name: gConf.communityName });
                    if (comm && Array.isArray(comm.groups)) {
                        for (const cGroup of comm.groups) {
                            try { await sock.groupParticipantsUpdate(cGroup, [jidNormalizedUser(target)], 'remove'); } catch {}

                            await GroupConfig.findOneAndUpdate(
                                { jid: cGroup },
                                { $push: { autoBanList: { jid: target, reason: `Embargo Institucional (Via Comunidade ${comm.name})`, admin: user.name } } },
                                { upsert: true }
                            );

                            await delay(200);
                        }
                    }
                } catch (errComm) { console.error('Erro ao processar comunidade no embargo:', errComm); }
            }

            const allGroupsObj = await sock.groupFetchAllParticipating();
            const groups = Object.values(allGroupsObj);

            const myId = jidNormalizedUser(sock.user.id);
            const myLid = sock.user.lid || myId;
            const targetNormalized = jidNormalizedUser(target);

            let count = 0;

            for (const group of groups) {
                try {
                    const freshMeta = await sock.groupMetadata(group.id);
                    const participants = freshMeta.participants;

                    const isPresent = participants.find(p => jidNormalizedUser(p.id) === targetNormalized);

                    if (isPresent) {
                        const meInGroup = participants.find(p => {
                            const pId = jidNormalizedUser(p.id);
                            return pId === myId || pId === myLid;
                        });

                        const botIsAdmin = meInGroup && (meInGroup.admin === 'admin' || meInGroup.admin === 'superadmin');

                        if (botIsAdmin) {
                            await sock.groupParticipantsUpdate(group.id, [targetNormalized], 'remove');
                            count++;
                        } else {
                            try {
                                await sock.groupParticipantsUpdate(group.id, [targetNormalized], 'remove');
                                count++;
                            } catch (e) {
                                console.log(`🚫 Sem permissão real em: ${freshMeta.subject}`);
                            }
                        }
                    }
                    await delay(1000);
                } catch (err) { console.log(`Erro no grupo ${group.id}`); }
            }

            await sock.sendMessage(jid, {
                text: `🔏. *EMBARGO FINALIZADO*\n\nInfrator: @${cleanID(target)}\nSetores Limpos: *${count}*\n\n_O bloqueio institucional de re-entrada foi ativado com sucesso._ 💜`,
                mentions: [target]
            });
            return true;
        }

        if (action === 'rmv') {
            const target = getTarget();
            if (!target) {
                await sock.sendMessage(jid, { text: '🎓| Mencione o usuário ou digite o número.\n| Ex: !comando @usuario | Motivo' });
                return true;
            }

            const tUser = await getUser(target);

            if (!tUser.embargo || !tUser.embargo.active) {
                await sock.sendMessage(jid, { text: '⚖️. Este usuário não possui um embargo ativo.' });
                return true;
            }

            clearEmbargoFields(tUser);
            await tUser.save();

            const msgRmv = `*⚖️| EMBARGO INSTITUCIONAL ACADEMY*\n\nCaro @${cleanID(target)},\n\nSeu embargo foi revogado pela Diretoria DEVS+. Você está livre para retornar.\n\nAtenciosamente, DEVS+ 💜`;

            await sock.sendMessage(target, { text: msgRmv });
            await notifyDirector(sock, {
                text:
                    `⚖️| *EMBARGO REVOGADO*\n` +
                    `Alvo: @${cleanID(target)}\n` +
                    `Admin: ${user.name} (@${senderNumber})\n` +
                    `Origem: ${isGroup ? `Grupo ${groupName}` : 'PV'} (${jid})\n` +
                    `Data: ${moment().format('DD/MM/YY HH:mm')}`,
                mentions: [target]
            });
            await sock.sendMessage(jid, { text: `✅ Embargo de @${cleanID(target)} revogado.`, mentions: [target] });
            return true;
        }

        if (action === 'list') {
            const list = await UserProfile.find({ 'embargo.active': true });
            let res = `⚖️| *EMBARGADOS DO INSTITUTO ACADEMY*\n> Total: ${list.length}\n\n`;
            list.forEach(u => {
                res += `🔐| @${cleanID(u.jid)} | ${u.embargo.duration}\n`;
            });
            await sock.sendMessage(jid, { text: res, mentions: list.map(l => l.jid) });
            return true;
        }

        if (action === 'busq') {
            await sock.sendMessage(jid, { text: '⚖️| *INICIANDO BUSCA GLOBAL...*' });
            const embargados = await UserProfile.find({ 'embargo.active': true });
            const allGroups = await sock.groupFetchAllParticipating();
            let detailMsg = `⚖️| *RESULTADO DA BUSCA:*\n\n`;
            const mnts = [];

            for (const gid in allGroups) {
                const group = allGroups[gid];
                for (const eb of embargados) {
                    const isPresent = group.participants.find(p => jidNormalizedUser(p.id) === jidNormalizedUser(eb.jid));
                    if (isPresent) {
                        detailMsg += `- Embargado: @${cleanID(eb.jid)}\n- Grupo: ${group.subject}\n\n`;
                        mnts.push(eb.jid);
                    }
                }
            }
            if (mnts.length === 0) {
                await sock.sendMessage(jid, { text: '⚖️| Nenhum infiltrado encontrado.' });
                return true;
            }
            await sock.sendMessage(jid, { text: detailMsg, mentions: mnts });
            return true;
        }

        const target = getTarget() || cleanSender;
        const tUser = await getUser(target);
        if (!tUser.embargo || !tUser.embargo.active) {
            await sock.sendMessage(jid, { text: '⚖️| Usuário limpo.' });
            return true;
        }

        await sock.sendMessage(jid, { text: `⚖️ @${cleanID(target)} está EMBARGADO.\nMotivo: ${tUser.embargo.reason}`, mentions: [target] });
        return true;
    }

    if (command === '!autoban') {
        if (!isMaster) return true;
        const sub = args[0]?.toLowerCase();
        const gConf = await GroupConfig.findOne({ jid }) || { autoBanList: [] };
        const locType = gConf.communityName ? 'comunidade' : 'grupo';
        const locName = gConf.communityName || groupName;

        if (sub === 'add') {
            const params = argText.replace('add', '').split('|').map(a => a.trim());
            const targetJid = getTarget();
            if (!targetJid || !params[1]) {
                await sock.sendMessage(jid, { text: '🌤. Use: !autoban add @user | motivo | link(opcional)' });
                return true;
            }

            const reason = params[1];
            const link = params[2] || 'Sem link';

            await GroupConfig.findOneAndUpdate({ jid }, {
                $push: { autoBanList: { jid: targetJid, reason, link, admin: user.name, date: new Date() } }
            }, { upsert: true });

            await sock.sendMessage(jid, { text: `📕| @${cleanID(targetJid)} foi adicionado a lista de auto ban do ${locType}!\n\n*Motivo:* ${reason}\n*Link:* ${link}`, mentions: [targetJid] });

            const msgPV = `📜| *INFORME ACADEMY*\n> Envio: ${moment().format('DD/MM/YY • HH:mm')}\n\nOlá @${cleanID(targetJid)}.\n\nVenho informar que você foi incluído na lista de auto banimento do ${locType} *${locName}*, por decisão de ${user.name}, pelo seguinte motivo:\n\n${reason}\n\nCaso entenda que a medida foi um equívoco, recorra em: analise@mail.acdm`;
            await sock.sendMessage(targetJid, { text: msgPV, mentions: [targetJid] });

            if (isSuperAdmin) await sock.groupParticipantsUpdate(jid, [targetJid], 'remove');
            return true;
        }

        if (sub === 'list') {
            let res = `📕| *LISTA DE AUTO BAN*\n> ${locName}\n> Em: ${moment().format('DD/MM/YY • HH:mm')}\n\n`;
            gConf.autoBanList.forEach(b => {
                res += `🔒| @${cleanID(b.jid)}\n> ╰> Por: ${b.admin}\n> ╰> Em: ${moment(b.date).format('DD/MM/YY')}\n`;
            });
            await sock.sendMessage(jid, { text: res, mentions: gConf.autoBanList.map(b => b.jid) });
            return true;
        }

        if (sub === 'rmv') {
            const targetJid = getTarget();
            if (!targetJid) {
                await sock.sendMessage(jid, { text: '🎓. Mencione o usuário ou digite o número para remover do AutoBan.' });
                return true;
            }

            await GroupConfig.findOneAndUpdate(
                { jid },
                { $pull: { autoBanList: { jid: targetJid } } },
                { new: true }
            );

            await sock.sendMessage(jid, {
                text: `📗| @${cleanID(targetJid)} foi removido da lista de autoban!`,
                mentions: [targetJid]
            });

            const msgPV = `📜| *INFORME ACADEMY*\n> Envio: ${moment().format('DD/MM/YY • HH:mm')}\n\nOlá @${cleanID(targetJid)}.\n\nVenho por meio deste informar que, após reavaliação administrativa, seu nome foi removido da lista de auto banimento do ${locType} *${locName}*.\n\nA presente decisão passa a ter efeito imediato, mantendo-se válidas as regras e normas do ${locType} *${locName}*, às quais todos os membros estão sujeitos.\n\n———\nAtenciosamente, Diretoria Academy 💜`;

            await sock.sendMessage(targetJid, { text: msgPV, mentions: [targetJid] });
            return true;
        }

        if (sub === 'busq') {
            const gConfNow = await GroupConfig.findOne({ jid });
            const locNameNow = gConfNow?.communityName || groupName;

            let blackList = [];
            if (gConfNow?.communityName) {
                const groupsInComm = await GroupConfig.find({ communityName: gConfNow.communityName });
                blackList = groupsInComm.flatMap(g => g.autoBanList);
            } else {
                blackList = gConfNow?.autoBanList || [];
            }

            const metadata = await sock.groupMetadata(jid);
            const foundLogs = [];
            const mentions = [];

            blackList.forEach(banned => {
                const isPresent = metadata.participants.find(p => jidNormalizedUser(p.id) === jidNormalizedUser(banned.jid));
                if (isPresent) {
                    foundLogs.push({
                        jid: banned.jid,
                        reason: banned.reason,
                        admin: banned.admin,
                        date: banned.date
                    });
                    mentions.push(banned.jid);
                }
            });

            await sock.sendMessage(jid, { text: `A busca resultou em *${foundLogs.length}* infratores no grupo/comunidade *${locNameNow}*!` });

            if (foundLogs.length > 0) {
                let detailMsg = `🔒| *INFRATORES DETECTADOS:*\n\n`;
                foundLogs.forEach(log => {
                    detailMsg += `🔒| @${cleanID(log.jid)}\n> Ocorrência: ${moment(log.date).format('DD/MM/YY HH:mm')}\n> Motivo: ${log.reason}\n> Por: ${log.admin}\n\n`;
                });
                await sock.sendMessage(jid, { text: detailMsg, mentions });
            } else {
                await sock.sendMessage(jid, { text: '📕| Nenhum registro de auto ban encontrado para este usuário na rede Academy!' });
            }
            return true;
        }

        const targetJid = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || cleanSender;
        const banData = gConf.autoBanList.find(b => b.jid === targetJid);

        if (!banData) {
            await sock.sendMessage(jid, { text: '📕| Nenhum registro encontrado para este usuário!' });
            return true;
        }

        const res = `📕| @${cleanID(targetJid)} está na lista de auto ban do ${locType} *${locName}*!\n\n🔒| @${cleanID(targetJid)}\n> Ocorrência: ${moment(banData.date).format('DD/MM/YY • HH:mm')}\n\n*Motivo:* ${banData.reason}\n*Link:* ${banData.link}\n*Por:* ${banData.admin}`;
        await sock.sendMessage(jid, { text: res, mentions: [targetJid] });
        return true;
    }

    if (command === '!dev') {
        if (!isOwner) {
            await sock.sendMessage(jid, { text: '🎓| Apenas o Diretor Chefe pode promover para Diretores' });
            return true;
        }
        const target = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        if (!target) {
            await sock.sendMessage(jid, { text: '🎓| Marque o membro ao qual deseja promover.' });
            return true;
        }

        const tUser = await getUser(target);
        tUser.rank = 'Dev';
        await tUser.save();
        await sock.sendMessage(jid, { text: `🅰️. @${cleanID(target)} foi promovido a *Diretor Academy*!`, mentions: [target] });
        return true;
    }

    if (command === '!master') {
        if (!isDev) {
            await sock.sendMessage(jid, { text: '🎓| Apenas Diretores podem nomear Masters.' });
            return true;
        }
        const target = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        if (!target) {
            await sock.sendMessage(jid, { text: '🎓| Marque o membro ao qual deseja promover.' });
            return true;
        }

        const tUser = await getUser(target);
        tUser.rank = 'Master';
        await tUser.save();
        await sock.sendMessage(jid, { text: `🎓| @${cleanID(target)} foi promovido a Mestre deste grupo!`, mentions: [target] });
        return true;
    }

    if (command === '!membro') {
        if (!isDev) {
            await sock.sendMessage(jid, { text: '🎓. Apenas Diretores podem rebaixar.' });
            return true;
        }
        const target = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        if (!target) {
            await sock.sendMessage(jid, { text: '🌤️. Marque o usuário.' });
            return true;
        }

        const tUser = await getUser(target);

        if (tUser.rank === 'Dev' && !isOwner) {
            await sock.sendMessage(jid, { text: '🅰️. Você não pode rebaixar outro Diretor.' });
            return true;
        }

        tUser.rank = 'Membro';
        await tUser.save();
        await sock.sendMessage(jid, { text: `💜. @${cleanID(target)} agora é um *Membro* Academy.`, mentions: [target] });
        return true;
    }

    if (command === '!canonizar') {
        if (!isDev) return true;
        const sub = args[0]?.toLowerCase();
        const target = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        if (!target) {
            await sock.sendMessage(jid, { text: '☀️| Marque o membro ao qual deseja Canonizar.' });
            return true;
        }

        const tUser = await getUser(target);

        if (sub === 'rmv') {
            tUser.isCanonized = false;
            await tUser.save();
            await sock.sendMessage(jid, { text: `*🌙. RETENÇÃO DE INTEGRIDADE*\n\nO status de @${cleanID(target)} foi alterado para: *DESCANONIZADO*.\nJustificativa: Revogação de privilégios por decisão do Conselho de Integridade (CINT).\n\n_Status: Vulnerável_`, mentions: [target] });
            return true;
        }

        tUser.isCanonized = true;
        await tUser.save();
        await sock.sendMessage(jid, { text: `*☀️| ASCENSÃO CANÔNICA*\nO Status Institucional de @${cleanID(target)} foi alterado para: *CANONIZADO*.\n\nJustificativa: Reconhecimento de Integridade. 💜\n\n> _Status: Imune a Penalidades_`, mentions: [target] });
        return true;
    }

    return false;
}

module.exports = { handleModerationCommands };
