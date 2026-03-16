const { escapeHtml, formatMoney } = require('../utils/formatters');

function buildRgPerfilHtmlV2(data) {
    const inventoryHtml = (data.inventory || Array(18).fill('')).concat(Array(18)).slice(0, 18).map((url) => {
        let style = '';
        if (url) {
            style = `background-image: url('${url}'); background-size: cover; background-position: center;`;
        }
        return `<div class="inv-slot" style="${style}"></div>`;
    }).join('');

    const devTagHtml = data.isBot
        ? `<span class="tag-devs">BOT</span>`
        : (data.isDev ? `<span class="tag-devs">DEVS+</span>` : '');
    const pinHtml = `<img class="pin" src="https://res.cloudinary.com/dhdkifjdt/image/upload/v1771599125/20260211_203129_o4fzuy.png" width="70px">`;

    const isLightColor = (color) => {
        if (!color) return false;
        const hex = color.replace('#', '');
        const r = parseInt(hex.substr(0, 2), 16);
        const g = parseInt(hex.substr(2, 2), 16);
        const b = parseInt(hex.substr(4, 2), 16);
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        return luminance > 0.6;
    };

    const bgColor = data.backgroundColor || '';
    const isDarkBg = !isLightColor(bgColor);
    const textColorWhite = '#ffffff';
    const finalBackgroundUrl = data.backgroundUrl || 'https://res.cloudinary.com/dhdkifjdt/image/upload/v1772716794/WhatsApp_Image_2026-03-04_at_15.12.40_p4wk79.jpg';

    let dynamicGradientsStyle = '';
    if (bgColor) {
        const hex = bgColor.replace('#', '');
        const r = parseInt(hex.substr(0, 2), 16);
        const g = parseInt(hex.substr(2, 2), 16);
        const b = parseInt(hex.substr(4, 2), 16);
        dynamicGradientsStyle = `
            <style>
                .header-image::after {
                    background: linear-gradient(to bottom, transparent 66%, rgba(${r},${g},${b},1) 85%, rgba(${r},${g},${b},1) 100%) !important;
                }
                .stat-val {
                    color: ${textColorWhite} !important;
                    text-shadow: 0 0 4px rgba(0,0,0,0.8) !important;
                }
                .char-name {
                    color: ${textColorWhite} !important;
                    text-shadow: 0 0 4px rgba(0,0,0,0.8) !important;
                }
                .role-secondary {
                    color: #dcdcdc !important;
                    text-shadow: 0 0 3px rgba(0,0,0,0.7) !important;
                }
                .divider {
                    background: ${isDarkBg ? 'var(--text-gold)' : '#8B7500'} !important;
                }
                .money-box {
                    background-color: ${isDarkBg ? 'var(--box-money)' : 'rgba(255, 200, 80, 0.08)'} !important;
                    border-color: ${isDarkBg ? '#5c4030' : 'rgba(139, 117, 0, 0.3)'} !important;
                }
                .inv-slot {
                    background-color: rgba(255, 200, 80, 0.1) !important;
                    border-color: rgba(255, 200, 80, 0.2) !important;
                }
            </style>
        `;
    }

    return `<!DOCTYPE html>
<html lang="pt-br">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>RG Academy</title>
    <link href="https://fonts.googleapis.com/css2?family=Yellowtail&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-dark: #251032;
            --bg-card: #281b35;
            --text-gold: #ffc850;
            --text-white: #ffffff;
            --text-gray: #b1a7bc;
            --border-color: #3e2d4d;
            --purple-bar: #7d12ff;
            --box-money: #3d2a1e;
            --card-width: 420px;
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            background-color: transparent;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            font-weight: 1000;
            font-family: 'Helvetica Neue', 'HelveticaNeue-CondensedBlack', Helvetica, Arial, sans-serif;
            font-synthesis: weight;
            -webkit-font-smoothing: antialiased;
        }
        .profile-container {
            width: 100%;
            max-width: var(--card-width);
            background-color: var(--bg-dark);
            position: relative;
            padding-bottom: 60px;
            box-shadow: 0 0 30px rgba(0, 0, 0, 0.8);
            overflow: hidden;
            font-weight: 1000;
            font-family: 'Helvetica Neue', 'HelveticaNeue-CondensedBlack', Helvetica, Arial, sans-serif;
        }
        .header-image {
            width: 100%;
            height: 420px;
            background-image: url('${finalBackgroundUrl}');
            background-size: cover;
            background-position: center top;
            position: relative;
            z-index: 1;
        }
        .header-image::after {
            content: '';
            position: absolute;
            bottom: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: linear-gradient(to bottom, transparent 66%, var(--bg-dark) 85%, var(--bg-dark) 100%);
            z-index: 2;
        }
        .avatar-section {
            position: relative;
            display: flex;
            justify-content: center;
            margin-top: -260px;
            z-index: 10;
        }
        .avatar-circle {
            width: 144px;
            height: 144px;
            border-radius: 50%;
            border: 3px solid var(--border-color);
            background-image: url('${data.avatarUrl || data.realAvatarUrl || 'https://res.cloudinary.com/dhdkifjdt/image/upload/v1772638834/WhatsApp_Image_2026-03-04_at_12.37.26_nkes8y.jpg'}');
            background-size: cover;
            background-position: center;
            box-shadow: 0 5px 25px rgba(0, 0, 0, 0.6);
            position: relative;
            overflow: visible;
        }
        .avatar-circle.canonized {
            border: 4px solid var(--text-gold);
        }
        .rank-badge {
            position: absolute;
            bottom: -18px;
            left: 50%;
            transform: translateX(-50%);
            font-family: 'Yellowtail', cursive;
            font-size: 22px;
            font-weight: 700;
            color: #e5ff61;
            text-shadow: -2px 1px 2px rgba(0, 0, 0, 0.95);
            padding: 0px 10px 4px 10px;
            z-index: 12;
            white-space: nowrap;
        }
        .info-section {
            text-align: center;
            padding: 0 15px;
            position: relative;
            z-index: 20;
            margin-top: 15px;
        }
        .char-name {
            font-size: 36px;
            letter-spacing: -1.5px;
            color: var(--text-white);
            text-transform: uppercase;
            margin-bottom: 5px;
            letter-spacing: -1px;
            display: inline-flex;
            justify-content: center;
            align-items: center;
            position: relative;
            line-height: 1;
            gap: 8px;
            font-weight: 1000;
        }
        .tag-devs {
            position: absolute;
            left: 100%;
            top: -5%;
            font-size: 13px;
            color: var(--text-gold);
            padding: 4px 6px;
            border-radius: 3px;
            transform: translateY(-6px) scale(1.05);
            font-weight: 1000;
        }
        .role-primary {
            font-size: 11px;
            font-weight: 1000;
            color: var(--text-gold);
            letter-spacing: 0.5px;
        }
        .role-primary .role-sep { color: #ffffff; margin: 0 6px; }
        .role-primary .role-item { display: inline; }
        .role-secondary {
            font-size: 12px;
            display: flex; justify-content: center; align-items: center; flex-direction: column;
            color: #dcdcdc;
            line-height: 1.2;
            max-width: 95%;
            height: 40px;
            margin: 0 auto;
            font-weight: 500;
        }
        .divider {
            height: 1px;
            background: var(--text-gold);
            margin-bottom: 10px;
            margin-top: 0px;
            margin-left: auto;
            margin-right: auto;
            width: 90%;
            position: relative;
            z-index: 5;
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(5, 1fr);
            text-align: center;
            margin-bottom: 25px;
            padding: 0 10px;
            position: relative;
            z-index: 5;
        }
        .stat-val {
            display: block;
            color: var(--text-white);
            font-weight: 1000;
            font-size: 19px;
            margin-bottom: 2px;
        }
        .stat-label {
            display: block;
            color: var(--text-gray);
            font-size: 8px;
            text-transform: uppercase;
            font-weight: 300;
        }
        .resources-wrapper {
            display: flex;
            align-items: flex-end;
            justify-content: space-between;
            padding: 0 25px;
            margin-bottom: 30px;
            gap: 15px;
            position: relative;
            z-index: 5;
        }
        .money-container {
            display: flex;
            flex-direction: column;
            position: relative;
        }
        .money-box {
            position: relative;
            background-color: var(--box-money);
            border: 1px solid #5c4030;
            border-radius: 6px;
            padding: 2px 6px;
            display: flex;
            align-items: center;
            gap: 10px;
            min-width: 120px;
            box-shadow: 0 2px 5px rgba(0, 0, 0, 0.2);
        }
        .money-value {
            color: var(--text-gold);
            font-weight: 1000;
            font-size: 16px;
            margin-left: 30px;
        }
        .inventory-grid {
            display: grid;
            grid-template-columns: repeat(6, 1fr);
            gap: 6px;
            padding: 0 20px;
            position: relative;
            z-index: 5;
        }
        .inv-slot {
            background-color: rgba(255, 200, 80, 0.1);
            border: 1px solid rgba(255, 200, 80, 0.2);
            height: 55px;
            width: 55px;
            transition: 0.2s;
        }
        .inv-slot:nth-child(6n+2),
        .inv-slot:nth-child(6n+4) {
            margin-right: 9px;
        }
        .pin {
            position: absolute;
            left: -25px;
            top: 50%;
            transform: translateY(-50%);
            filter: drop-shadow(2px 2px 2px rgba(0,0,0,0.5));
        }
    </style>
    ${dynamicGradientsStyle}
</head>
<body>
    <div class="profile-container" id="rg-card" style="${data.backgroundColor ? `background-color: ${data.backgroundColor};` : ''}">
        <div class="header-image"></div>
        <div class="avatar-section">
            <div class="avatar-circle${data.isCanonized ? ' canonized' : ''}">
                <div class="rank-badge">${data.rankTag}</div>
            </div>
        </div>
        <div class="info-section">
            <h1 class="char-name">
                <p style="letter-spacing: -1.5px; font-size: 25px; font-weight: 1000">${data.displayName}</p>
                ${devTagHtml}
            </h1>
            <div class="role-primary">${data.roles}</div>
            <div class="role-secondary">${data.description}</div>
        </div>
        <div class="divider"></div>
        <div class="stats-grid">
            <div><span class="stat-val">${data.groupCount}</span><span class="stat-label">Grupos</span></div>
            <div><span class="stat-val">${data.messageCount}</span><span class="stat-label">Mensagens</span></div>
            <div><span class="stat-val">${data.charisma}</span><span class="stat-label">Carisma</span></div>
            <div><span class="stat-val">${data.prestige}</span><span class="stat-label">Prestígio</span></div>
            <div><span class="stat-val">${data.collection}</span><span class="stat-label">Coleção</span></div>
        </div>
        <div class="resources-wrapper">
            <div class="money-container">
                <div class="money-box">
                    ${pinHtml}
                    <span class="money-value">${data.academyCash}</span>
                </div>
            </div>
        </div>
        <div class="inventory-grid">
            ${inventoryHtml}
        </div>
    </div>
</body>
</html>`;
}

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRandom(list) {
    if (!Array.isArray(list) || list.length === 0) return '';
    return list[randomInt(0, list.length - 1)];
}

function buildMockRgPerfilData() {
    const names = ['Asterion Vale', 'Lyra Noctis', 'Kael Draven', 'Mira Solari', 'Orion Kade', 'Selene Arctis'];
    const bios = [
        'Estrategista da Academy, especialista em operações de alto risco.',
        'Arcanista de elite focada em proteção e contrainteligência.',
        'Comandante tático de campo com histórico impecável em missões.',
        'Analista de dados operacionais e coordenação de squads.'
    ];
    const roleSets = [
        ['Conselho', 'Diretoria'],
        ['Arcanista', 'Sentinela'],
        ['Comando Tático', 'Operações'],
        ['Inteligência', 'Coordenação']
    ];
    const sampleImages = [
        'https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=420&h=580&q=80',
        'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?auto=format&fit=crop&w=420&h=580&q=80',
        'https://images.unsplash.com/photo-1504384308090-c894fdcc538d?auto=format&fit=crop&w=420&h=580&q=80',
        'https://images.unsplash.com/photo-1465101162946-4377e57745c3?auto=format&fit=crop&w=420&h=580&q=80'
    ];
    const avatarPool = [
        'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=320&h=320&q=80',
        'https://images.unsplash.com/photo-1527980965255-d3b416303d12?auto=format&fit=crop&w=320&h=320&q=80',
        'https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&w=320&h=320&q=80',
        'https://images.unsplash.com/photo-1552058544-f2b08422138a?auto=format&fit=crop&w=320&h=320&q=80'
    ];
    const badgePool = [
        'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&fit=crop&w=110&h=110&q=80',
        'https://images.unsplash.com/photo-1550684376-efcbd6e3f031?auto=format&fit=crop&w=110&h=110&q=80',
        'https://images.unsplash.com/photo-1469474968028-56623f02e42e?auto=format&fit=crop&w=110&h=110&q=80',
        'https://images.unsplash.com/photo-1446776811953-b23d57bd21aa?auto=format&fit=crop&w=110&h=110&q=80',
        'https://images.unsplash.com/photo-1519125323398-675f0ddb6308?auto=format&fit=crop&w=110&h=110&q=80'
    ];

    const selectedRoles = pickRandom(roleSets);
    const inventory = Array.from({ length: 18 }, (_, idx) => (idx < randomInt(5, 14) ? pickRandom(badgePool) : ''));

    return {
        backgroundUrl: pickRandom(sampleImages),
        avatarUrl: pickRandom(avatarPool),
        realAvatarUrl: pickRandom(avatarPool),
        rankTag: `#${randomInt(1, 999)}`,
        displayName: pickRandom(names),
        isCanonized: Math.random() > 0.5,
        isDev: Math.random() > 0.4,
        roles: Array.isArray(selectedRoles)
            ? selectedRoles.map((role) => `<span class="role-item">${escapeHtml(role)}</span>`).join('<span class="role-sep">•</span>')
            : 'Membro Academy',
        description: pickRandom(bios),
        groupCount: randomInt(1, 34),
        messageCount: randomInt(1200, 98500),
        charisma: randomInt(10, 999),
        prestige: randomInt(0, 500),
        collection: randomInt(0, 18),
        academyCash: formatMoney(randomInt(1000, 9999999)),
        inventory
    };
}

module.exports = {
    buildRgPerfilHtmlV2,
    buildMockRgPerfilData
};
