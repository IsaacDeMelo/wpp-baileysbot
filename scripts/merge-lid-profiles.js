#!/usr/bin/env node

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');
const DRY = !APPLY;
const PROGRESS_EVERY = Math.max(25, Number(process.env.MIGRATE_PROGRESS_EVERY || 100));

const RANK_LEVEL = { Membro: 0, Master: 1, Coord: 1, Dev: 2 };

function normalizePhoneDigits(value) {
  const digits = String(value || '').replace(/\D+/g, '');
  if (!digits) return '';
  return digits;
}

function isLikelyPhoneDigits(digits) {
  const d = normalizePhoneDigits(digits);
  if (!d) return false;
  if (!d.startsWith('55')) return false;
  return d.length >= 12 && d.length <= 13;
}

function getLidJid(doc) {
  const lid = String(doc?.lid || '');
  if (lid.endsWith('@lid')) return lid;
  const jid = String(doc?.jid || '');
  if (jid.endsWith('@lid')) return jid;
  return '';
}

function resolvePhoneFromLid(lidDigits) {
  const lid = normalizePhoneDigits(lidDigits);
  if (!lid) return '';
  try {
    const file = path.join(process.cwd(), 'auth_info_baileys', `lid-mapping-${lid}_reverse.json`);
    if (!fs.existsSync(file)) return '';
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const pn = normalizePhoneDigits(raw?.pn || raw?.phoneNumber || '');
    return isLikelyPhoneDigits(pn) ? pn : '';
  } catch {
    return '';
  }
}

function dedupeArrayBy(arr, keyFn) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(arr) ? arr : []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function mergeActiveGroups(a, b) {
  const map = new Map();
  for (const g of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    const key = String(g?.jid || '').trim();
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, { ...g });
      continue;
    }
    const cur = map.get(key);
    cur.groupName = cur.groupName || g.groupName;
    cur.role = cur.role || g.role;
    cur.msgCount = Number(cur.msgCount || 0) + Number(g.msgCount || 0);

    const curJoined = cur.joinedAt ? new Date(cur.joinedAt) : null;
    const gJoined = g.joinedAt ? new Date(g.joinedAt) : null;
    if (!curJoined || (gJoined && gJoined < curJoined)) cur.joinedAt = g.joinedAt;

    const curLast = cur.lastActive ? new Date(cur.lastActive) : null;
    const gLast = g.lastActive ? new Date(g.lastActive) : null;
    if (!curLast || (gLast && gLast > curLast)) cur.lastActive = g.lastActive;

    map.set(key, cur);
  }
  return Array.from(map.values());
}

function mergeMailLists(a, b) {
  const map = new Map();
  for (const list of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    const name = String(list?.name || '').trim().toLowerCase();
    if (!name) continue;
    if (!map.has(name)) {
      map.set(name, { name, targets: [] });
    }
    const item = map.get(name);
    const targets = Array.isArray(list?.targets) ? list.targets : [];
    item.targets = dedupeArrayBy([...item.targets, ...targets], (t) => String(t || '').trim().toLowerCase());
    map.set(name, item);
  }
  return Array.from(map.values());
}

function betterBio(targetBio, sourceBio) {
  const t = String(targetBio || '').trim();
  const s = String(sourceBio || '').trim();
  const isDefault = (v) => !v || /^sem biografia definida\.?$/i.test(v);
  if (isDefault(t) && !isDefault(s)) return s;
  return t || s;
}

function higherRank(a, b) {
  const ar = String(a || 'Membro');
  const br = String(b || 'Membro');
  return (RANK_LEVEL[br] ?? 0) > (RANK_LEVEL[ar] ?? 0) ? br : ar;
}

function mergeProfiles(target, source, phoneDigits, canonicalJid) {
  const out = { ...target };

  out.jid = canonicalJid || out.jid;
  out.phoneNumber = phoneDigits || out.phoneNumber || '';
  out.lid = out.lid || source.lid || (String(source.jid || '').endsWith('@lid') ? source.jid : '');

  out.name = out.name || source.name;
  out.realName = out.realName || source.realName;
  out.nickname = out.nickname || source.nickname;
  out.rank = higherRank(out.rank, source.rank);
  out.supremeTitle = out.supremeTitle || source.supremeTitle;
  out.bio = betterBio(out.bio, source.bio);

  out.avatar = out.avatar || source.avatar;
  out.backgroundUrl = out.backgroundUrl || source.backgroundUrl;
  out.backgroundColor = out.backgroundColor || source.backgroundColor;
  out.borderColor = out.borderColor || source.borderColor;
  out.dividerColor = out.dividerColor || source.dividerColor;
  out.roleSepColor = out.roleSepColor || source.roleSepColor;

  out.isCanonized = Boolean(out.isCanonized || source.isCanonized);
  out.isMailRegistered = Boolean(out.isMailRegistered || source.isMailRegistered);

  out.charisma = Math.max(Number(out.charisma || 0), Number(source.charisma || 0));
  out.prestige = Math.max(Number(out.prestige || 0), Number(source.prestige || 0));
  out.academyCash = Math.max(Number(out.academyCash || 0), Number(source.academyCash || 0));

  out.cargos = dedupeArrayBy([...(out.cargos || []), ...(source.cargos || [])], (x) => String(x || '').trim().toLowerCase());
  out.honors = dedupeArrayBy([...(out.honors || []), ...(source.honors || [])], (h) => String(h?.nameLower || h?.name || h?.imageUrl || '').toLowerCase());

  out.activeGroups = mergeActiveGroups(out.activeGroups, source.activeGroups);
  out.inactiveGroups = dedupeArrayBy([...(out.inactiveGroups || []), ...(source.inactiveGroups || [])], (g) => `${g?.jid || ''}|${g?.period || ''}`);

  out.globalWarnings = dedupeArrayBy([...(out.globalWarnings || []), ...(source.globalWarnings || [])], (w) => String(w?.id || `${w?.reason || ''}|${w?.date || ''}`));
  out.localWarnings = dedupeArrayBy([...(out.localWarnings || []), ...(source.localWarnings || [])], (w) => String(w?.id || `${w?.groupJid || ''}|${w?.reason || ''}|${w?.date || ''}`));
  out.mailLists = mergeMailLists(out.mailLists, source.mailLists);

  out.nameHistory = dedupeArrayBy([...(out.nameHistory || []), ...(source.nameHistory || [])], (n) => `${n?.name || ''}|${n?.date || ''}`);
  out.observations = dedupeArrayBy([...(out.observations || []), ...(source.observations || [])], (o) => `${o?.text || ''}|${o?.date || ''}`);
  out.embargoHistory = dedupeArrayBy([...(out.embargoHistory || []), ...(source.embargoHistory || [])], (e) => `${e?.reason || ''}|${e?.since || ''}|${e?.admin || ''}`);

  return out;
}

function changedFields(before, after) {
  const changed = [];
  for (const [k, v] of Object.entries(after)) {
    if (k === '_id' || k === '__v') continue;
    const b = before[k];
    if (JSON.stringify(b) !== JSON.stringify(v)) changed.push(k);
  }
  return changed;
}

(async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URL || process.env.DB_URI;
  if (!uri) {
    console.error('❌ Mongo URI não encontrada. Use MONGO_URI/MONGODB_URI/MONGO_URL/DB_URI.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const col = mongoose.connection.db.collection('userprofiles');

  const docs = await col.find({}).toArray();
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  const docsByJid = new Map();
  for (const d of docs) {
    const j = String(d.jid || '');
    if (!j) continue;
    docsByJid.set(j, d);
  }

  const groups = new Map(); // phoneDigits -> docIds
  const lidGroups = new Map(); // lidJid -> docIds

  for (const d of docs) {
    const lidJid = getLidJid(d);
    if (!lidJid) continue;

    if (!lidGroups.has(lidJid)) lidGroups.set(lidJid, new Set());
    lidGroups.get(lidJid).add(String(d._id));

    const lidDigits = normalizePhoneDigits(lidJid.split('@')[0]);
    const mapped = resolvePhoneFromLid(lidDigits);
    const phoneDigits = mapped || (isLikelyPhoneDigits(d.phoneNumber) ? normalizePhoneDigits(d.phoneNumber) : '');
    if (!phoneDigits) continue;
    if (!groups.has(phoneDigits)) groups.set(phoneDigits, new Set());
    groups.get(phoneDigits).add(String(d._id));

    // também inclui perfil já em @s.whatsapp.net se existir
    const canonicalJid = `${phoneDigits}@s.whatsapp.net`;
    const existingCanonical = docsByJid.get(canonicalJid);
    if (existingCanonical?._id) groups.get(phoneDigits).add(String(existingCanonical._id));
  }

  let merges = 0;
  let updates = 0;
  let deletes = 0;
  let skipped = 0;

  const processGroup = async ({ phoneDigits = '', idSet, fallbackLid = '' }) => {
    const profileDocs = Array.from(idSet || []).map((id) => byId.get(id)).filter(Boolean);
    if (!profileDocs.length) return;

    const canonicalJid = phoneDigits ? `${phoneDigits}@s.whatsapp.net` : '';
    let target = (canonicalJid && profileDocs.find((d) => String(d.jid || '') === canonicalJid))
      || profileDocs.find((d) => String(d.jid || '').endsWith('@s.whatsapp.net'))
      || profileDocs[0];

    const targetId = String(target._id);
    let mergedTarget = { ...target };

    for (const s of profileDocs) {
      const sid = String(s._id);
      if (sid === targetId) continue;

      const effectivePhone = phoneDigits || (isLikelyPhoneDigits(mergedTarget.phoneNumber) ? normalizePhoneDigits(mergedTarget.phoneNumber) : '');
      const effectiveCanonicalJid = effectivePhone ? `${effectivePhone}@s.whatsapp.net` : (canonicalJid || mergedTarget.jid);

      mergedTarget = mergeProfiles(mergedTarget, s, effectivePhone, effectiveCanonicalJid);

      if (DRY) {
        if (VERBOSE) console.log(`[DRY] DELETE source ${sid} (${s.jid || ''}) -> target ${targetId}`);
      } else {
        await col.deleteOne({ _id: s._id });
      }
      byId.delete(sid);
      merges += 1;
      deletes += 1;
    }

    const effectivePhone = phoneDigits || (isLikelyPhoneDigits(mergedTarget.phoneNumber) ? normalizePhoneDigits(mergedTarget.phoneNumber) : '');
    const effectiveCanonicalJid = effectivePhone
      ? `${effectivePhone}@s.whatsapp.net`
      : (canonicalJid || mergedTarget.jid || fallbackLid || '');

    mergedTarget = mergeProfiles(mergedTarget, {}, effectivePhone, effectiveCanonicalJid);
    if (!mergedTarget.lid && fallbackLid) mergedTarget.lid = fallbackLid;

    const changed = changedFields(target, mergedTarget);
    if (changed.length) {
      const payload = { ...mergedTarget };
      delete payload._id;
      if (DRY) {
        console.log(`[DRY] UPDATE target ${targetId} -> ${effectiveCanonicalJid || target.jid} | fields: ${changed.join(', ')}`);
      } else {
        await col.updateOne({ _id: target._id }, { $set: payload });
      }
      updates += 1;
    } else {
      skipped += 1;
    }

    byId.set(targetId, mergedTarget);
  };

  let processedPhoneGroups = 0;
  let processedLidGroups = 0;

  // 1) Primeiro consolida por telefone resolvido
  for (const [phoneDigits, idSet] of groups.entries()) {
    await processGroup({ phoneDigits, idSet });
    processedPhoneGroups += 1;
    if (processedPhoneGroups % PROGRESS_EVERY === 0) {
      console.log(`[PROGRESS] phoneGroups ${processedPhoneGroups}/${groups.size} | merges=${merges} updates=${updates} deletes=${deletes}`);
    }
  }

  // 2) Depois consolida sobras duplicadas por LID (quando não houve mapeamento de telefone)
  for (const [lidJid, idSet] of lidGroups.entries()) {
    const aliveIds = Array.from(idSet).filter((id) => byId.has(id));
    if (aliveIds.length <= 1) continue;
    await processGroup({ idSet: new Set(aliveIds), fallbackLid: lidJid });
    processedLidGroups += 1;
    if (processedLidGroups % PROGRESS_EVERY === 0) {
      console.log(`[PROGRESS] lidGroups ${processedLidGroups}/${lidGroups.size} | merges=${merges} updates=${updates} deletes=${deletes}`);
    }
  }

  const summary = {
    mode: DRY ? 'dry-run' : 'apply',
    scannedProfiles: docs.length,
    groupsResolved: groups.size,
    lidGroups: lidGroups.size,
    merges,
    updates,
    deletes,
    unchangedTargets: skipped
  };

  console.log(JSON.stringify(summary, null, 2));
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error('❌ Falha na migração:', err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
