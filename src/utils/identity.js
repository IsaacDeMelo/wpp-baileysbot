function createIdentityUtils({
    jidNormalizedUser,
    fs,
    path,
    baseDir,
    defaultCountryCode,
    ownerJids,
    myPhoneNumbers
}) {
    const LID_REVERSE_CACHE = new Map();

    function cleanID(jid) {
        if (!jid) return '';
        return String(jid).split('@')[0].split(':')[0];
    }

    function normalizePhoneDigits(input) {
        return String(input || '').replace(/\D/g, '');
    }

    function phoneDigitsToJid(digits) {
        const d = normalizePhoneDigits(digits);
        if (!d) return '';

        if ((d.length === 10 || d.length === 11) && defaultCountryCode) {
            return jidNormalizedUser(defaultCountryCode + d + '@s.whatsapp.net');
        }

        if (d.length >= 12 && d.length <= 15) {
            return jidNormalizedUser(d + '@s.whatsapp.net');
        }

        return '';
    }

    function parseJidFromInput(raw) {
        const s = String(raw || '').trim();
        if (!s) return '';

        if (s.includes('@')) return jidNormalizedUser(s);

        const waMe = s.match(/wa\.me\/(\d{8,20})/i);
        if (waMe) return phoneDigitsToJid(waMe[1]);

        const digits = normalizePhoneDigits(s);
        if (!digits) return '';

        if (digits.length >= 15 && defaultCountryCode === '55' && !digits.startsWith('55')) {
            return jidNormalizedUser(digits + '@lid');
        }

        return phoneDigitsToJid(digits);
    }

    function extractFirstJidFromText(text) {
        const t = String(text || '');
        if (!t) return '';

        const explicitJid = t.match(/\b([0-9A-Za-z._-]{6,})@(s\.whatsapp\.net|g\.us|lid)\b/i);
        if (explicitJid) return parseJidFromInput(explicitJid[0]);

        const waMe = t.match(/wa\.me\/(\d{8,20})/i);
        if (waMe) return parseJidFromInput(waMe[0]);

        const tokens = t.split(/[\s|,;]+/g).filter(Boolean);
        for (const token of tokens) {
            const jid = parseJidFromInput(token);
            if (jid) return jid;
        }

        const bigDigits = t.match(/\d[\d().\s-]{9,}\d/);
        if (bigDigits) {
            const jid = parseJidFromInput(bigDigits[0]);
            if (jid) return jid;
        }

        return '';
    }

    function resolvePhoneFromLid(lidDigits) {
        const lid = normalizePhoneDigits(lidDigits);
        if (!lid) return '';
        if (LID_REVERSE_CACHE.has(lid)) return LID_REVERSE_CACHE.get(lid) || '';

        try {
            const filePath = path.join(baseDir, 'auth_info_baileys', `lid-mapping-${lid}_reverse.json`);
            const raw = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(raw);
            const digits = normalizePhoneDigits(parsed);
            LID_REVERSE_CACHE.set(lid, digits || null);
            return digits || '';
        } catch {
            LID_REVERSE_CACHE.set(lid, null);
            return '';
        }
    }

    function jidToPhoneDigits(jid) {
        const normalizedJid = jidNormalizedUser(jid || '');
        if (!normalizedJid) return '';
        const idPart = cleanID(normalizedJid);
        if (normalizedJid.endsWith('@lid')) {
            return resolvePhoneFromLid(idPart);
        }
        return normalizePhoneDigits(idPart);
    }

    function getBotIdentitySet(socket) {
        const set = new Set();
        try {
            if (socket?.user?.id) set.add(jidNormalizedUser(socket.user.id));
            if (socket?.user?.lid) set.add(jidNormalizedUser(socket.user.lid));
        } catch {}
        return set;
    }

    function phoneVariantsFromDigits(digits) {
        const normalizedDigits = normalizePhoneDigits(digits);
        const set = new Set();
        if (!normalizedDigits) return set;
        set.add(normalizedDigits);

        if (normalizedDigits.startsWith('55')) {
            if (normalizedDigits.length === 12) {
                set.add(normalizedDigits.slice(0, 4) + '9' + normalizedDigits.slice(4));
            } else if (normalizedDigits.length === 13 && normalizedDigits[4] === '9') {
                set.add(normalizedDigits.slice(0, 4) + normalizedDigits.slice(5));
            }
        }

        return set;
    }

    function buildVariantDigitsSet(digitsList) {
        const set = new Set();
        for (const digits of (digitsList || [])) {
            for (const variant of phoneVariantsFromDigits(digits)) {
                set.add(variant);
            }
        }
        return set;
    }

    function anyVariantInSet(digits, set) {
        const variants = phoneVariantsFromDigits(digits);
        for (const variant of variants) {
            if (set.has(variant)) return true;
        }
        return false;
    }

    function isSameIdentity(a, b) {
        const normalizedA = jidNormalizedUser(a || '');
        const normalizedB = jidNormalizedUser(b || '');
        if (!normalizedA || !normalizedB) return false;
        if (normalizedA === normalizedB) return true;

        const digitsA = jidToPhoneDigits(normalizedA);
        const digitsB = jidToPhoneDigits(normalizedB);
        if (!digitsA || !digitsB) return false;

        return anyVariantInSet(digitsA, buildVariantDigitsSet([digitsB]));
    }

    function normalizeOwnerJid(raw) {
        const value = String(raw || '').trim();
        if (!value) return '';
        if (value.includes('@')) return jidNormalizedUser(value);
        const digits = normalizePhoneDigits(value);
        if (digits) return jidNormalizedUser(digits + '@s.whatsapp.net');
        return jidNormalizedUser(value);
    }

    const OWNER_JID_SET = new Set((ownerJids || []).map(normalizeOwnerJid).filter(Boolean));
    const OWNER_DIGITS_SET = new Set(
        (ownerJids || [])
            .map((value) => cleanID(normalizeOwnerJid(value)))
            .map((value) => normalizePhoneDigits(value))
            .filter(Boolean)
    );

    function isMyNumber(candidateDigits) {
        const candidateVariants = phoneVariantsFromDigits(candidateDigits);
        if (candidateVariants.size === 0) return false;

        for (const raw of (myPhoneNumbers || [])) {
            const myDigits = normalizePhoneDigits(raw);
            const myVariants = phoneVariantsFromDigits(myDigits);
            for (const variant of candidateVariants) {
                if (myVariants.has(variant)) return true;
            }
        }

        return false;
    }

    function isOwnerIdentity(candidate) {
        const value = String(candidate || '').trim();
        if (!value) return false;

        if (value.includes('@')) {
            const normalized = jidNormalizedUser(value);
            const digits = normalizePhoneDigits(cleanID(normalized));
            return isMyNumber(digits) || OWNER_JID_SET.has(normalized) || OWNER_DIGITS_SET.has(digits);
        }

        const digits = normalizePhoneDigits(value);
        return isMyNumber(digits) || OWNER_DIGITS_SET.has(digits);
    }

    return {
        cleanID,
        normalizePhoneDigits,
        phoneDigitsToJid,
        parseJidFromInput,
        extractFirstJidFromText,
        jidToPhoneDigits,
        getBotIdentitySet,
        phoneVariantsFromDigits,
        buildVariantDigitsSet,
        anyVariantInSet,
        isSameIdentity,
        isMyNumber,
        isOwnerIdentity,
        normalizeOwnerJid
    };
}

module.exports = {
    createIdentityUtils
};
