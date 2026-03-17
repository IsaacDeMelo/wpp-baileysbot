const RANK_LEVELS = { Membro: 0, Master: 1, Dev: 2 };

function rankToLevel(rank) {
    return RANK_LEVELS[String(rank || 'Membro')] ?? 0;
}

const COMMAND_CATALOG = [
    {
        minRank: 'Membro',
        commands: [
            '!menu', '!help', '!guia', '!comandos', '!helpall',
            '!whoami', '!id', '!debuguser', '!whoarehim',
            '!perfil', '!perfis', '!perfilpic', '!bio', '!nickname', '!background-img', '!capa-img', '!linkimg', '!userg',
            '!ping', '!sticker', '!s', '!play', '!mp3'
        ]
    },
    {
        minRank: 'Master',
        commands: [
            '!adv', '!rmadv', '!listadv', '!listaadv', '!kick', '!autoban', '!embargo',
            '!antispam', '!antisticker',
            '!cadastrarmail', '!cadastrargp', '!listgp', '!criarlistmail', '!addmail', '!mail',
            '!listmailusers', '!listusuariosmail',
            '!ping-scanner',
            '!carismatar', '!carismastatus',
            '!addcargo', '!rmcargo', '!addhonraria', '!bodlink',
            '!autorepo', '!addimage', '!rmimage', '!rmimg', '!removeimage', '!delimage',
            '!comunidade', '!comunidades'
        ]
    },
    {
        minRank: 'Dev',
        commands: [
            '!dev', '!master', '!membro', '!canonizar',
            '!varredura', '!sweep', '!varrer',
            '!bot', '!ia', '!setconselho', '!setdiretoria',
            '!globalusers', '!filtrog',
            '!help add', '!help del',
            '!img', '!background', '!border-color', '!divider-color', '!rolesep-color', '!gradient',
            '!addcargodefinitivo', '!carrossel'
        ]
    }
];

function buildManualText(rank) {
    const lvl = rankToLevel(rank);
    const parts = [];
    parts.push(`🏛️ *GUIA COMPLETO ACADEMY* (Acesso: ${rank})`);

    parts.push('\n📚 *AJUDA & NAVEGACAO*');
    parts.push('• *!menu / !help:* Menu rápido por contexto.');
    parts.push('• *!guia:* Manual completo por categoria.');
    parts.push('• *!comandos / !helpall:* Lista de comandos visíveis no seu rank.');
    parts.push('• *!help add* / *!help del:* (Dev) Gerencia entradas do menu dinâmico.');

    parts.push('\n🧠 *IA & DIAGNOSTICO*');
    parts.push('• *!whoami / !id:* Mostra seu JID/ID técnico.');
    parts.push('• *!debuguser / !whoarehim:* Diagnóstico de identidade/JID/LID.');
    if (lvl >= RANK_LEVELS.Dev) parts.push('• *!ia on/off:* Liga/desliga Auto-IA (escopo por permissão).');

    parts.push('\n📇 *PERFIL & IDENTIDADE*');
    parts.push('• *!perfil [@user]:* Gera o RG/identidade visual.');
    parts.push('• *!perfis:* Envia seu perfil + de até 3 outros (online ou aleatórios).');
    parts.push('• *!perfilpic:* Define avatar personalizado (imagem marcada/enviada).');
    parts.push('• *!perfilpic reset:* Remove avatar personalizado.');
    parts.push('• *!nickname Nome:* Define nickname RPG.');
    parts.push('• *!bio texto:* Define biografia do perfil.');
    parts.push('• *!background-img / !capa-img:* Define imagem de capa do RG.');
    parts.push('• *!linkimg:* Converte imagem em URL direta.');
    parts.push('• *!userg [@user]:* Relatório técnico completo do usuário.');

    parts.push('\n🧰 *UTILITARIOS*');
    parts.push('• *!ping:* Teste de latência.');
    parts.push('• *!sticker / !s:* Cria figurinha a partir de imagem/vídeo.');
    parts.push('• *!play / !mp3:* Busca e baixa áudio do SoundCloud (padrão). Use prefixo *yt:* para buscar no YouTube.');

    if (lvl >= RANK_LEVELS.Master) {
        parts.push('\n⚖️ *MODERACAO & SEGURANCA*');
        parts.push('• *!adv @user | motivo:* Advertência local/comunitária.');
        parts.push('• *!adv global @user | motivo | tempo:* Advertência global.');
        parts.push('• *!rmadv @user | local/global | id:* Remove advertência.');
        parts.push('• *!listadv / !listaadv @user:* Lista advertências.');
        parts.push('• *!kick @user:* Remove usuário do grupo (e comunidade quando aplicável).');
        parts.push('• *!autoban add/rmv/list/busq:* Gestão da lista de auto-ban.');
        parts.push('• *!embargo @user / add / rmv / list / busq:* Banimento global Academy.');
        parts.push('\n🛡️ *ANTI-SPAM*');
        parts.push('• *!antispam on/off:* Liga/desliga sistema anti-flood.');
        parts.push('• *!antispam config TempoMS | MaxMsgs | Repetir(s/n) | Punicao:* Configuração detalhada.');
        parts.push('• *!antisticker on/off:* Liga/desliga filtro de figurinhas.');
        parts.push('• *!antisticker config Limite | TempoMS | Punicao:* Configuração detalhada.');
        parts.push('\n✉️ *MAIL SYSTEM*');
        parts.push('• *!cadastrarmail:* Habilita conta para envio de mail.');
        parts.push('• *!cadastrargp nick | descricao:* Registra grupo para mail.');
        parts.push('• *!listgp:* Lista grupos cadastrados no mail.');
        parts.push('• *!criarlistmail nome:* Cria lista pessoal de destinatários.');
        parts.push('• *!addmail list nome | alvos:* Adiciona usuários/grupos à lista.');
        parts.push('• *!mail destino assunto | mensagem:* Envia mail.');
        parts.push('• *!listmailusers / !listusuariosmail:* Lista remetentes habilitados.');
        parts.push('\n🧩 *COMUNIDADES*');
        parts.push('• *!comunidade criar Nome | Desc:* Cria comunidade.');
        parts.push('• *!comunidade capa Nome:* Altera a capa da comunidade (com imagem).');
        parts.push('• *!comunidade apagar Nome:* Exclui a comunidade e limpa vínculos dos grupos.');
        parts.push('• *!comunidade addgp Nome:* Adiciona grupo atual à comunidade.');
        parts.push('• *!comunidade rmvgp:* Remove grupo atual da comunidade.');
        parts.push('• *!comunidade Nome:* Mostra painel da comunidade.');
        parts.push('• *!comunidades:* Lista comunidades globais.');
        parts.push('\n📦 *AUTOREPO (SISTEMA LEGADO)*');
        parts.push('• *!autorepo add/rmv/list:* Gerencia respostas automáticas.');
        parts.push('• *!addimage trigger:* Adiciona imagem a um trigger do autorepo.');
        parts.push('• *!rmimage / !rmimg / !removeimage / !delimage:* Remove imagem do trigger.');
        parts.push('\n📮 *NOVO SISTEMA DE AUTORESPONDER*');
        parts.push('*LOCAL (por grupo):*');
        parts.push('• *!respoadd <trigger> || Mensagem:* Registra resposta automática local.');
        parts.push('• *!respoimg <trigger>:* Adiciona/atualiza imagem (marque uma imagem).');
        parts.push('• *!respormv <trigger>:* Remove resposta local.');
        parts.push('• *!respolist:* Lista todas as respostas locais.');
        parts.push('*COMUNITARIA (por comunidade):*');
        parts.push('• *!autoadd <trigger> || Mensagem:* Registra resposta automática comunitária.');
        parts.push('• *!autoimg <trigger>:* Adiciona/atualiza imagem (marque uma imagem).');
        parts.push('• *!autormv <trigger>:* Remove resposta comunitária.');
        parts.push('• *!autolist:* Lista todas as respostas comunitárias.');
        parts.push('*GLOBAL (toda a rede):*');
        parts.push('• *!replyadd <trigger> || Mensagem:* Registra resposta automática global.');
        parts.push('• *!replyimg <trigger>:* Adiciona/atualiza imagem (marque uma imagem).');
        parts.push('• *!replyrmv <trigger>:* Remove resposta global.');
        parts.push('• *!replylist:* Lista todas as respostas globais (Dev only).');
        parts.push('\n🏅 *CARGOS & HONRARIAS*');
        parts.push('• *!addcargo @user/numero Cargo:* Adiciona cargo (aceita número bruto/JID).');
        parts.push('• *!addcargo rank:Dev Cargo:* Adiciona cargo para todos de um rank.');
        parts.push('• *!rmcargo @user [cargo]:* Remove cargo específico ou todos.');
        parts.push('• *!addhonraria @user Nome:* Atribui honraria já cadastrada.');
        parts.push('• *!bodlink:* Gera link/preview do grupo atual.');
        parts.push('\n💞 *CARISMA*');
        parts.push('• *!carismatar 1000 | 10 | 2h:* Local atual: próximas msgs com limite de tempo opcional.');
        parts.push('• *!carismatar global 1000 | 10 | 2h:* Versão global.');
        parts.push('• *!carismatar off* / *!carismatar global off:* Desativa campanha local/global.');
        parts.push('• *!carismastatus:* Mostra status local e global das campanhas.');
        parts.push('• Reação ❤️ em perfil: +100 carisma (1 like por perfil por dia).');
    }

    if (lvl >= RANK_LEVELS.Dev) {
        parts.push('\n👑 *DIRETORIA (DEV)*');
        parts.push('• *!dev @user:* Promove para Dev (restrito a Owner).');
        parts.push('• *!master @user:* Promove para Master.');
        parts.push('• *!membro @user:* Rebaixa para Membro.');
        parts.push('• *!canonizar @user* / *!canonizar rmv @user:* Imunidade de sistema.');
        parts.push('• *!addcargodefinitivo @user titulo:* Define cargo supremo.');
        parts.push('\n🎨 *PERSONALIZACAO RG (DEV)*');
        parts.push('• *!background cor:* Cor de fundo do RG.');
        parts.push('• *!border-color cor:* Cor da borda do avatar.');
        parts.push('• *!divider-color cor:* Cor do divisor central.');
        parts.push('• *!rolesep-color cor:* Cor da bolinha entre cargos.');
        parts.push('• *!gradient start end:* Ajusta gradiente do cabeçalho.');
        parts.push('\n🧪 *ADMIN / SISTEMA (DEV)*');
        parts.push('• *!varredura / !sweep / !varrer:* Varredura de segurança.');
        parts.push('• *!bot on/off:* Liga/desliga bot no grupo.');
        parts.push('• *!setconselho* / *!setdiretoria:* Define grupos estratégicos.');
        parts.push('• *!globalusers:* Relatório global de usuários.');
        parts.push('• *!filtrog:* Filtro/consulta avançada no banco.');
        parts.push('• *!img Nome | Valor:* Cadastra/atualiza honraria por imagem.');
        parts.push('• *!carrossel <termo>:* Busca Pinterest e envia em carrossel (com fallback).');
    }

    parts.push('\nℹ️ *OBSERVACOES*');
    parts.push('• Comandos com @ exigem menção válida ou resposta ao alvo.');
    parts.push('• Alguns comandos exigem contexto de grupo e/ou admin.');
    parts.push('• Use *!comandos* para lista enxuta por rank.');

    return parts.join('\n');
}

function buildCommandListText(rank) {
    const lvl = rankToLevel(rank);
    const set = new Set();
    for (const group of COMMAND_CATALOG) {
        if (lvl >= rankToLevel(group.minRank)) {
            group.commands.forEach((command) => set.add(command));
        }
    }
    const list = Array.from(set).sort((a, b) => a.localeCompare(b));
    const header = `📚 *LISTA DE COMANDOS (Rank: ${rank})*\n• Total visiveis: ${list.length}`;
    const body = list.length ? list.map((command) => `• ${command}`).join('\n') : 'Nenhum comando disponivel.';
    return `${header}\n\n${body}`;
}

function getCommandListForPrompt(rank) {
    const lvl = rankToLevel(rank);
    const set = new Set();
    for (const group of COMMAND_CATALOG) {
        if (lvl >= rankToLevel(group.minRank)) {
            group.commands.forEach((command) => set.add(command));
        }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b)).join(', ');
}

function buildAutorepoHelp({ groupName, communityName } = {}) {
    const commTxt = communityName ? `*${communityName}*` : '🌤️. Este grupo não está em comunidade';
    return (
        `*🎓. AUTO-REPO (Auto Respostas por Comando)*\n\n` +
        `Você pode registrar comandos simples que o bot responde automaticamente.\n` +
        `As respostas aceitam variáveis como: {sender.name}, {sender.rank}, {group.name}, {argText}, {args.0}, {now.time} e também {{sender.name}}.\n\n` +
        `*✦. Escopo*\n` +
        `*╰* Local* = só neste grupo (${groupName || 'grupo atual'})\n` +
        `*╰* Comunidade* = para todos os grupos da comunidade ${commTxt}\n\n` +
        `*✦. Cadastrar*\n` +
        `*╰* !autorepo add local !bomdia | Bom dia, {sender.name}!\n` +
        `*╰* !autorepo add comunidade !regras | Regras da comunidade: ...\n\n` +
        `*✦. Listar*\n` +
        `*╰* !autorepo list local\n` +
        `*╰* !autorepo list comunidade\n\n` +
        `*✦. Remover*\n` +
        `*╰* !autorepo rmv local !bomdia\n` +
        `*╰* !autorepo rmv comunidade !regras\n\n` +
        `*✦. Importante*\n` +
        `*╰* Para usar _comunidade_, este grupo precisa pertencer a uma comunidade registrada (via !comunidade addgp).\n` +
        `*╰* Triggers reservados do sistema não podem ser usados.`
    );
}

function parseAutorepoScope(raw) {
    const value = String(raw || '').toLowerCase().trim();
    if (!value) return null;
    if (value === 'local' || value === 'grupo') return 'local';
    if (value === 'comunidade' || value === 'comunidades' || value === 'community' || value === 'comm') return 'comunidade';
    return null;
}

function normalizeTrigger(trigger) {
    const value = String(trigger || '').trim();
    if (!value) return '';
    return (value.startsWith('!') ? value : ('!' + value)).toLowerCase();
}

module.exports = {
    AUTOREPO_RESERVED: new Set([
        '!autorepo',
        '!addimage',
        '!rmimage', '!rmimg', '!removeimage', '!delimage',
        '!respoadd', '!respoimg', '!respormv', '!respolist',
        '!autoadd', '!autoimg', '!autormv', '!autolist',
        '!replyadd', '!replyimg', '!replyrmv', '!replylist',
        '!perfis', '!pins',
        '!carismatar', '!carismastatus'
    ]),
    RANK_LEVELS,
    rankToLevel,
    COMMAND_CATALOG,
    buildManualText,
    buildCommandListText,
    getCommandListForPrompt,
    buildAutorepoHelp,
    parseAutorepoScope,
    normalizeTrigger
};
