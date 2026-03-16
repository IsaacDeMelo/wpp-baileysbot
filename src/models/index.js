function initModels(mongoose) {
    const UserProfileSchema = new mongoose.Schema({
        jid: { type: String, unique: true },
        lid: { type: String, default: '' },
        name: String,
        realName: String,
        nickname: { type: String, default: '' },
        phoneNumber: String,
        rank: { type: String, enum: ['Membro', 'Master', 'Coord', 'Dev'], default: 'Membro' },
        supremeTitle: { type: String, default: '' },
        bio: { type: String, default: 'Sem biografia definida.' },
        cargos: { type: [String], default: [] },
        isCanonized: { type: Boolean, default: false },
        backgroundUrl: { type: String, default: null },
        avatar: { type: String, default: '' },
        borderColor: { type: String, default: '#3e2d4d' },
        dividerColor: { type: String, default: '#ffc850' },
        roleSepColor: { type: String, default: '#ffffff' },
        gradientStart: { type: Number, default: 60 },
        gradientEnd: { type: Number, default: 92 },
        backgroundColor: { type: String, default: '' },
        totalMessageCount: { type: Number, default: 0, index: true },
        globalRank: { type: Number, default: 0, index: true },
        globalRankUpdatedAt: { type: Date, default: null },
        charisma: { type: Number, default: 0 },
        prestige: { type: Number, default: 0 },
        academyCash: { type: Number, default: 0 },
        honors: [{
            name: String,
            nameLower: String,
            imageUrl: String,
            value: { type: Number, default: 0 },
            grantedBy: String,
            grantedAt: { type: Date, default: Date.now }
        }],
        activeGroups: [{
            jid: String,
            groupName: String,
            role: String,
            joinedAt: { type: Date, default: Date.now },
            msgCount: { type: Number, default: 0 },
            lastActive: { type: Date, default: Date.now }
        }],
        inactiveGroups: [{ jid: String, groupName: String, role: String, period: String, finalMsgCount: Number }],
        globalWarnings: [{
            id: String,
            reason: String,
            date: { type: Date, default: Date.now },
            admin: String,
            duration: String,
            endDate: Date
        }],
        localWarnings: [{
            id: String,
            groupJid: String,
            groupName: String,
            reason: String,
            date: { type: Date, default: Date.now },
            admin: String
        }],
        isMailRegistered: { type: Boolean, default: false },
        mailLists: [{
            name: { type: String, lowercase: true },
            targets: [String]
        }],
        embargo: {
            active: { type: Boolean, default: false },
            reason: String,
            link: String,
            since: Date,
            duration: String,
            endDate: Date,
            admin: String
        },
        embargoHistory: [{
            reason: String,
            link: String,
            since: Date,
            duration: String,
            endDate: Date,
            admin: String,
            concludedAt: Date
        }],
        nameHistory: [{ name: String, date: { type: Date, default: Date.now } }],
        observations: [{ text: String, date: { type: Date, default: Date.now }, author: String }]
    });

    const CommunitySchema = new mongoose.Schema({
        name: { type: String, unique: true },
        description: String,
        creatorJid: String,
        imageUrl: { type: String, default: null },
        createdAt: { type: Date, default: Date.now },
        groups: [String],
        autoRepo: [{
            trigger: { type: String, lowercase: true, trim: true },
            response: { type: String, default: '' },
            imageUrl: { type: String, default: '' },
            imagePublicId: { type: String, default: '' },
            enabled: { type: Boolean, default: true },
            createdAt: { type: Date, default: Date.now },
            createdBy: { type: String, default: '' }
        }],
        activityLog: [{
            date: { type: String },
            count: { type: Number, default: 0 }
        }]
    });

    const CommandDocSchema = new mongoose.Schema({
        trigger: { type: String, unique: true },
        category: String,
        description: String,
        rankRequired: { type: String, enum: ['Membro', 'Master', 'Dev'], default: 'Membro' }
    });

    const GroupConfigSchema = new mongoose.Schema({
        jid: { type: String, unique: true },
        nick: { type: String, lowercase: true },
        description: String,
        mailRegistered: { type: Boolean, default: false },
        communityName: { type: String, default: null },
        botActive: { type: Boolean, default: true },
        pingScannerEnabled: { type: Boolean, default: false },
        antispam: {
            enabled: { type: Boolean, default: false },
            maxMsgs: { type: Number, default: 5 },
            windowMs: { type: Number, default: 5000 },
            antiRepeat: { type: Boolean, default: true },
            punishment: { type: String, default: 'local' }
        },
        antisticker: {
            enabled: { type: Boolean, default: false },
            limit: { type: Number, default: 3 },
            windowMs: { type: Number, default: 10000 },
            punishment: { type: String, default: 'local' }
        },
        autoBanList: [{ jid: String, reason: String, link: String, admin: String, date: { type: Date, default: Date.now } }],
        autoRepo: [{
            trigger: { type: String, lowercase: true, trim: true },
            response: { type: String, default: '' },
            imageUrl: { type: String, default: '' },
            imagePublicId: { type: String, default: '' },
            enabled: { type: Boolean, default: true },
            createdAt: { type: Date, default: Date.now },
            createdBy: { type: String, default: '' }
        }]
    });

    const SystemConfigSchema = new mongoose.Schema({
        allowedGroups: [String],
        systemInstruction: { type: String, default: 'Você é um assistente útil e carismático do WhatsApp.' },
        directorGroupJid: { type: String, default: '' },
        botActive: { type: Boolean, default: true },
        globalReplies: [{
            trigger: { type: String, lowercase: true, trim: true },
            response: { type: String, default: '' },
            imageUrl: { type: String, default: '' },
            imagePublicId: { type: String, default: '' },
            enabled: { type: Boolean, default: true },
            createdAt: { type: Date, default: Date.now },
            createdBy: { type: String, default: '' }
        }]
    });

    const CampaignSchema = new mongoose.Schema({
        name: { type: String, required: true },
        text: { type: String, default: '' },
        interval: { type: Number, default: 30 },
        targetGroups: { type: [String], default: [] },
        mediaUrl: { type: String, default: '' },
        mediaType: { type: String, default: '' },
        stats: {
            sentTotal: { type: Number, default: 0 },
            lastSentAt: { type: Date, default: null }
        }
    }, { timestamps: true });

    const BadgeSchema = new mongoose.Schema({
        name: { type: String, unique: true },
        nameLower: { type: String, index: true },
        imageUrl: { type: String, default: '' },
        value: { type: Number, default: 0 },
        createdBy: { type: String, default: '' },
        createdAt: { type: Date, default: Date.now }
    });

    const CarismaCampaignSchema = new mongoose.Schema({
        scopeKey: { type: String, unique: true },
        scopeType: { type: String, enum: ['local', 'global'], default: 'local' },
        remainingMessages: { type: Number, default: 0 },
        charismaPerMessage: { type: Number, default: 0 },
        enabled: { type: Boolean, default: true },
        startedAt: { type: Date, default: Date.now },
        expiresAt: { type: Date, default: null },
        durationRaw: { type: String, default: '' },
        createdBy: { type: String, default: '' },
        createdAt: { type: Date, default: Date.now },
        updatedAt: { type: Date, default: Date.now }
    });

    const ProfileLikeDailySchema = new mongoose.Schema({
        day: { type: String, index: true },
        likerJid: { type: String, index: true },
        targetJid: { type: String, index: true },
        createdAt: { type: Date, default: Date.now }
    });

    ProfileLikeDailySchema.index({ day: 1, likerJid: 1, targetJid: 1 }, { unique: true });

    return {
        UserProfile: mongoose.models.UserProfile || mongoose.model('UserProfile', UserProfileSchema),
        Community: mongoose.models.Community || mongoose.model('Community', CommunitySchema),
        CommandDoc: mongoose.models.CommandDoc || mongoose.model('CommandDoc', CommandDocSchema),
        GroupConfig: mongoose.models.GroupConfig || mongoose.model('GroupConfig', GroupConfigSchema),
        SystemConfig: mongoose.models.SystemConfig || mongoose.model('SystemConfig', SystemConfigSchema),
        Campaign: mongoose.models.Campaign || mongoose.model('Campaign', CampaignSchema),
        Badge: mongoose.models.Badge || mongoose.model('Badge', BadgeSchema),
        CarismaCampaign: mongoose.models.CarismaCampaign || mongoose.model('CarismaCampaign', CarismaCampaignSchema),
        ProfileLikeDaily: mongoose.models.ProfileLikeDaily || mongoose.model('ProfileLikeDaily', ProfileLikeDailySchema)
    };
}

module.exports = {
    initModels
};
