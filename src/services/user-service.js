const moment = require('moment');

function createUserService({
    UserProfile,
    jidNormalizedUser,
    jidToPhoneDigits,
    cleanID,
    normalizePhoneDigits,
    isOwnerIdentity,
    communityActivityQueue,
    groupActivityQueue
}) {
    async function updateCommunityActivity(communityName, count = 1) {
        if (!communityName) return;
        const key = String(communityName);
        const inc = Number(count) || 1;
        communityActivityQueue.set(key, (communityActivityQueue.get(key) || 0) + inc);
    }

    function getCommunityStats(community) {
        const now = moment();
        const currentWeek = community.activityLog.filter((log) => moment(log.date).isAfter(now.clone().subtract(7, 'days'))).reduce((a, b) => a + b.count, 0);
        const lastWeek = community.activityLog.filter((log) => moment(log.date).isBetween(now.clone().subtract(14, 'days'), now.clone().subtract(7, 'days'))).reduce((a, b) => a + b.count, 0);
        return { currentWeek, lastWeek };
    }

    function clearEmbargoFields(userDoc) {
        if (!userDoc.embargo) userDoc.embargo = {};
        userDoc.embargo.active = false;
        userDoc.embargo.reason = '';
        userDoc.embargo.link = '';
        userDoc.embargo.since = null;
        userDoc.embargo.duration = '';
        userDoc.embargo.endDate = null;
        userDoc.embargo.admin = '';
    }

    async function concludeEmbargoIfExpired(userDoc) {
        if (!userDoc?.embargo?.active) return false;
        const endDate = userDoc.embargo.endDate ? new Date(userDoc.embargo.endDate) : null;
        if (!endDate || isNaN(endDate.getTime())) return false;
        if (Date.now() < endDate.getTime()) return false;

        if (!Array.isArray(userDoc.embargoHistory)) userDoc.embargoHistory = [];
        userDoc.embargoHistory.push({
            reason: userDoc.embargo.reason,
            link: userDoc.embargo.link,
            since: userDoc.embargo.since,
            duration: userDoc.embargo.duration,
            endDate: userDoc.embargo.endDate,
            admin: userDoc.embargo.admin,
            concludedAt: new Date()
        });

        clearEmbargoFields(userDoc);
        await userDoc.save();
        return true;
    }

    async function concludeExpiredEmbargosBatch() {
        const now = new Date();
        const expired = await UserProfile.find({
            'embargo.active': true,
            'embargo.endDate': { $ne: null, $lte: now }
        }).limit(200);

        for (const u of expired) {
            try { await concludeEmbargoIfExpired(u); } catch {}
        }
    }

    async function getUser(jid, name) {
        try {
            const cleanJid = jidNormalizedUser(jid);
            const isLidJid = cleanJid.endsWith('@lid');
            const isDupKeyError = (err) => Number(err?.code) === 11000 || String(err?.message || '').includes('E11000');

            const mappedPhoneDigits = jidToPhoneDigits(cleanJid);
            const incomingDigits = mappedPhoneDigits || (!isLidJid ? cleanID(cleanJid) : '');
            const stableDigits = normalizePhoneDigits(incomingDigits);
            const stableJid = stableDigits ? jidNormalizedUser(stableDigits + '@s.whatsapp.net') : cleanJid;
            const isOwnerByPhone = isOwnerIdentity(cleanJid) || isOwnerIdentity(stableDigits);
            const loadExistingUser = async () => {
                const or = [{ jid: stableJid }, { jid: cleanJid }];
                if (isLidJid) or.push({ lid: cleanJid });
                return UserProfile.findOne({ $or: or });
            };

            let user = await UserProfile.findOne({ jid: stableJid });
            if (!user) user = await UserProfile.findOne({ jid: cleanJid });
            if (!user && isLidJid) {
                user = await UserProfile.findOne({ lid: cleanJid });
            }

            if (!user && stableDigits) {
                let variant1 = stableDigits;
                let variant2 = stableDigits;

                if (stableDigits.length === 12) {
                    variant2 = stableDigits.slice(0, 4) + '9' + stableDigits.slice(4);
                } else if (stableDigits.length === 13) {
                    variant2 = stableDigits.slice(0, 4) + stableDigits.slice(5);
                }

                user = await UserProfile.findOne({
                    phoneNumber: { $in: [variant1, variant2] }
                });

                if (user) {
                    console.log(`[DB] Usuário encontrado por telefone! Atualizando JID de ${user.jid} para ${stableJid}`);
                    user.jid = stableJid;
                    user.phoneNumber = stableDigits;
                    if (isLidJid) user.lid = cleanJid;
                    try {
                        await user.save();
                    } catch (err) {
                        if (isDupKeyError(err)) {
                            const existing = await loadExistingUser();
                            if (existing) user = existing;
                        } else {
                            throw err;
                        }
                    }
                }
            }

            if (!user) {
                console.log(`[DB] Usuário Novo Criado: ${stableJid}`);
                const isDev = isOwnerByPhone;

                try {
                    user = await UserProfile.create({
                        jid: stableJid,
                        lid: isLidJid ? cleanJid : '',
                        name: name || 'Desconhecido',
                        phoneNumber: stableDigits || '',
                        rank: isDev ? 'Dev' : 'Membro'
                    });
                } catch (err) {
                    if (isDupKeyError(err)) {
                        user = await loadExistingUser();
                        if (!user) throw err;
                    } else {
                        throw err;
                    }
                }
            }

            if (isLidJid && user.lid !== cleanJid) {
                user.lid = cleanJid;
                try {
                    await user.save();
                } catch (err) {
                    if (isDupKeyError(err)) {
                        const existing = await loadExistingUser();
                        if (existing) user = existing;
                    } else {
                        throw err;
                    }
                }
            }

            try { await concludeEmbargoIfExpired(user); } catch {}

            if (isOwnerByPhone && user.rank !== 'Dev') {
                user.rank = 'Dev';
                try {
                    await user.save();
                } catch (err) {
                    if (isDupKeyError(err)) {
                        const existing = await loadExistingUser();
                        if (existing) user = existing;
                    } else {
                        throw err;
                    }
                }
            }

            if (name && user.name === 'Desconhecido') {
                user.name = name;
                try {
                    await user.save();
                } catch (err) {
                    if (isDupKeyError(err)) {
                        const existing = await loadExistingUser();
                        if (existing) user = existing;
                    } else {
                        throw err;
                    }
                }
            }

            return user;
        } catch (e) {
            console.error('❌ Erro no getUser:', e);
            return { name: 'Erro', rank: 'Membro', activeGroups: [], globalWarnings: [], localWarnings: [], embargo: {}, embargoHistory: [] };
        }
    }

    async function trackGroupActivity(user, groupJid, groupName, role) {
        if (!groupJid.endsWith('@g.us')) return;

        const userJid = String(user?.jid || '');
        if (!userJid) return;

        const key = `${userJid}|${groupJid}`;
        const currentRole = role || 'Membro';
        const existing = groupActivityQueue.get(key);

        if (existing) {
            existing.inc += 1;
            existing.groupName = groupName;
            existing.role = currentRole;
            existing.lastActive = new Date();
        } else {
            groupActivityQueue.set(key, {
                userJid,
                groupJid,
                groupName,
                role: currentRole,
                inc: 1,
                lastActive: new Date()
            });
        }
    }

    return {
        updateCommunityActivity,
        getCommunityStats,
        clearEmbargoFields,
        concludeEmbargoIfExpired,
        concludeExpiredEmbargosBatch,
        getUser,
        trackGroupActivity
    };
}

module.exports = {
    createUserService
};
