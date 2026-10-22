const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const dns = require('dns').promises;
const net = require('net');
const zlib = require('zlib');

const app = express();

app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header(
        'Access-Control-Allow-Headers',
        'Origin, X-Requested-With, Content-Type, Accept'
    );
    next();
});

// ============================================================
// BASIC CONFIG
// ============================================================

const BROWSER_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CHUNK_SIZE = 165;
const CONCURRENCY_LIMIT = 3;

// După orice răspuns HTTP 429, nu pornim alte cereri Gemini timp de 5 secunde.
// Pauzele Retry-After/cooldown ale proiectului rămân separate și pot fi mai lungi.
const GEMINI_429_INTER_REQUEST_PAUSE_MS = 5000;

// După calupul 12, spațiem pornirile cererilor aferente calupurilor 13+ la 2 secunde.
const GEMINI_DEFAULT_REQUEST_START_INTERVAL_MS = 1200;
const GEMINI_LATER_CHUNK_START_INTERVAL_MS = 2000;
const GEMINI_LATER_CHUNK_PACING_START_CHUNK = 13;

const CONTEXT_LINES_BEFORE = 12;
const CONTEXT_LINES_AFTER = 12;
const PREVIOUS_TRANSLATION_CONTEXT = 8;

const MODEL_NAME =
    process.env.GEMINI_MODEL ||
    'gemini-3.5-flash-lite';

// ============================================================
// CONSOLE COLORS
// ============================================================

const c = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m'
};

// ============================================================
// MEMORY CACHE & SECRET ARCHIVE (MAX 30 ELEMENTE)
// ============================================================

const memoryCache = new Map();
const secretArchive = [];

// Textul englez sursă, păstrat temporar ca să poată fi descărcat din arhivă (comparație calitate).
const originalSources = Object.create(null);
// Cache LRU limitat: o instanță Render poate procesa permanent titluri noi.
// Evităm creșterea fără limită și nu păstrăm răspunsurile valide dar fără titlu.
const MEDIA_TITLE_CACHE_MAX = 500;
const mediaTitleCache = new Map();
// Context scurt (an, genuri, sinopsis) pentru prompt. Provine din ACELAȘI răspuns
// Cinemeta folosit pentru titlu, deci nu adaugă nicio cerere de rețea.
const mediaContextCache = new Map();

function buildMediaContextText(meta) {
    const clean = (value, max) => String(value || '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/[<>`]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
    const title = clean(meta.name || meta.title, 120);
    if (!title) return '';
    const year = clean(meta.releaseInfo || meta.year, 20);
    const genres = Array.isArray(meta.genres)
        ? meta.genres.map(g => clean(g, 30)).filter(Boolean).slice(0, 4).join(', ')
        : '';
    const synopsis = clean(meta.description || meta.overview, 380);
    const parts = [`Title: ${title}${year ? ` (${year})` : ''}`];
    if (genres) parts.push(`Genres: ${genres}`);
    if (synopsis) parts.push(`Synopsis: ${synopsis}`);
    return parts.join('\n');
}

// Glosar opțional pe titlu (cheia = ID IMDb de bază). Termenii de aici sunt trimiși modelului ca forme
// românești FIXE, ca același nume să nu fie tradus diferit în calupuri sau episoade diferite.
// Editează liber: adaugă un ID nou cu perechi [original, forma în română].
const MEDIA_GLOSSARIES = {
    // Foundation (Apple TV+)
    tt0804484: [
        ['The Mule', 'Catârul (declinat natural: Catârul, Catârului, pe Catâr)'],
        ['Brazen Head', 'Capul de Aramă'],
        ['Luminists / Luminism', 'luminiști / luminism'],
        ['Inheritors', 'Moștenitori'],
        ['Remediation', 'Remediere']
    ]
};

function getMediaGlossaryText(imdbBaseId) {
    const entries = MEDIA_GLOSSARIES[String(imdbBaseId || '').toLowerCase()];
    if (!Array.isArray(entries) || !entries.length) return '';
    const lines = entries
        .filter(pair => Array.isArray(pair) && pair[0] && pair[1])
        .map(([from, to]) => `${String(from).replace(/[<>`]/g, '')} = ${String(to).replace(/[<>`]/g, '')}`);
    return lines.length
        ? `Glossary (fixed Romanian forms; use exactly these, inflecting naturally):\n${lines.join('\n')}`
        : '';
}

function getMediaContextText(mediaId) {
    const rawId = String(mediaId || '').trim();
    const match = rawId.match(/^(tt\d+)(?::(\d+)(?::(\d+))?)?$/i);
    if (!match) return '';
    const mediaType = rawId.includes(':') ? 'series' : 'movie';
    const base = mediaContextCache.get(`${mediaType}:${match[1]}`) || '';
    const episode = base && match[2] && match[3] ? `\nEpisode: season ${match[2]}, episode ${match[3]}` : '';
    const glossary = getMediaGlossaryText(match[1]);
    return [base + episode, glossary].filter(Boolean).join('\n');
}

// Rezolvă numele filmului/serialului din Cinemeta pentru antetul de început.
// Dacă metadatele lipsesc, traducerea continuă folosind ID-ul.
async function fetchMediaTitle(mediaId) {
    const rawId = String(mediaId || '').trim();
    const match = rawId.match(/^(tt\d+)(?::\d+(?::\d+)?)?$/i);
    if (!match) return '';

    const baseId = match[1];
    const mediaType = rawId.includes(':') ? 'series' : 'movie';
    const cacheKey = `${mediaType}:${baseId}`;
    if (mediaTitleCache.has(cacheKey)) {
        const cachedTitle = mediaTitleCache.get(cacheKey);
        // Mutăm accesul la final pentru a păstra în cache titlurile folosite recent.
        mediaTitleCache.delete(cacheKey);
        mediaTitleCache.set(cacheKey, cachedTitle);
        return cachedTitle;
    }

    try {
        const response = await axios.get(
            `https://v3-cinemeta.strem.io/meta/${mediaType}/${baseId}.json`,
            { timeout: 2500, headers: { 'User-Agent': BROWSER_USER_AGENT } }
        );
        const meta = response.data?.meta || response.data?.item?.meta || {};
        const title = String(meta.name || meta.title || '')
            .replace(/[\r\n\t]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (title) {
            mediaTitleCache.set(cacheKey, title);
            const contextText = buildMediaContextText(meta);
            if (contextText) mediaContextCache.set(cacheKey, contextText);
            if (mediaTitleCache.size > MEDIA_TITLE_CACHE_MAX) {
                const oldestKey = mediaTitleCache.keys().next().value;
                if (oldestKey !== undefined) {
                    mediaTitleCache.delete(oldestKey);
                    mediaContextCache.delete(oldestKey);
                }
            }
        }
        return title;
    } catch (_) {
        // O eroare temporară (timeout/Cinemeta indisponibil) nu se memorează:
        // următoarea cerere trebuie să poată încerca din nou recuperarea titlului.
        return '';
    }
}

function resolveSubtitleSourceLabel(sourceValue, versionValue) {
    const source = String(sourceValue ?? '').trim().toLowerCase();
    if (source === 'subdl') return 'SubDL';
    if (source === 'opensubtitles') return 'OpenSubtitles';
    const versionTag = String(versionValue ?? '').trim().toLowerCase();
    if (/^subdl(?:-|$)/.test(versionTag)) return 'SubDL';
    if (/^opensubtitles(?:-|$)/.test(versionTag)) return 'OpenSubtitles';
    return 'Necunoscută';
}

function logTranslationStart(mediaId, mediaTitle, subtitleInfo = {}) {
    const headline = '🎬 ÎNCEPE TRADUCEREA';
    const cleanId = String(mediaId || 'ID necunoscut')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const cleanTitle = String(mediaTitle || '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const details = cleanTitle ? `${cleanId} — ${cleanTitle}` : cleanId;
    const subtitleName = sanitizeSubtitleLogValue(subtitleInfo.subtitleName) || 'Nedisponibilă (link vechi)';
    const subtitleSource = resolveSubtitleSourceLabel(subtitleInfo.subtitleSource, subtitleInfo.versionTag);

    // Păstrăm antetul existent și adăugăm sursa/subtitrarea selectată, fără URL-uri sau secrete.
    const divider = '\x1b[90m────────────────────────────────────\x1b[0m';
    console.log(divider);
    console.log(`\x1b[96m${headline}\x1b[0m`);
    console.log(`\x1b[93m${details}\x1b[0m`);
    console.log(`\x1b[95m📄 Subtitrare selectată: ${subtitleName}\x1b[0m`);
    console.log(`\x1b[95m📚 Sursă subtitrare: ${subtitleSource}\x1b[0m`);
    console.log(divider);
}
function rememberOriginalSource(key, text) {
    originalSources[key] = text;
    const keys = Object.keys(originalSources);
    if (keys.length > 12) {
        for (let i = 0; i < keys.length - 12; i++) delete originalSources[keys[i]];
    }
}

// Returnează o intrare și o mută la finalul Map-ului pentru o ordine LRU simplă.
function getMemoryCacheEntry(key) {
    if (!memoryCache.has(key)) return undefined;
    const value = memoryCache.get(key);
    memoryCache.delete(key);
    memoryCache.set(key, value);
    return value;
}

// Limitează cache-ul la 30 de rezultate finalizate. Promisiunile active nu sunt
// evacuate: altfel o cerere identică ar putea porni o a doua traducere Gemini.
// protectedKey este păstrată în timpul curățării pentru a nu elimina tocmai
// rezultatul accesat sau finalizat cel mai recent.
function cleanMemoryCache(protectedKey = null) {
    if (memoryCache.size <= 30) return;

    for (const [key, value] of memoryCache) {
        if (memoryCache.size <= 30) break;
        if (key === protectedKey) continue;
        if (typeof value === 'string') {
            memoryCache.delete(key);
        }
    }
}

// ============================================================
// MANIFEST
// ============================================================

const manifest = {
    id: 'community.chios.geminitranslator',
    version: '13.2.30',
    name: 'RO Sub Translator',
    logo: 'https://raw.githubusercontent.com/Chios01/ro-sub-translator/main/Design_Litera_C_i_litera_G_sunt_suprapuse_i_se_mpletesc_ca_z.jpg',
    description: 'Subtitrări instant din Engleză în Română, traduse inteligent prin Gemini AI. Powered by Chios.',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    catalogs: [],
    idPrefixes: ['tt'],
    behaviorHints: {
        configurable: true,
        configurationRequired: false
    }
};

// ============================================================
// ROOT, PING & ARHIVA SECRETA
// ============================================================

app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(indexPath)) {
        let html = fs.readFileSync(indexPath, 'utf8');
        html = html.replace(/\{\{VERSION\}\}/g, manifest.version);
        return res.send(html);
    }
    res.send('RO Sub Translator is running.');
});

app.get('/ping', (req, res) => {
    res.send('OK');
});

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>\"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '\"': '&quot;',
        "'": '&#39;'
    })[character]);
}

// ID-ul este folosit și în numele fișierului atașat. Păstrăm doar caractere
// sigure pentru un nume portabil și evităm caractere de control/header injection.
function safeAttachmentId(value) {
    const safe = String(value ?? 'subtitle')
        .replace(/[^a-zA-Z0-9._:-]/g, '_')
        .replace(/\.{2,}/g, '.')
        .slice(0, 100);
    return safe || 'subtitle';
}

app.get('/arhiva-secreta', (req, res) => {
    let html = '<html lang="ro"><head><title>Arhiva Secreta - Quality Control</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>';
    html += '<body style="background:#111;color:#eee;font-family:sans-serif;padding:20px;">';
    html += '<h2 style="color:#0f0;">Arhiva Subtitrări (Ultimele 10)</h2>';
    html += '<p>Aceste fișiere sunt reținute temporar în memoria serverului. Se vor șterge la restart.</p>';
    
    if (secretArchive.length === 0) {
        html += '<p style="color:#aaa;">Nicio subtitrare tradusă momentan.</p>';
    } else {
        html += '<ul style="list-style-type:none; padding:0;">';
        secretArchive.forEach((item, index) => {
            html += `<li style="background:#222; margin-bottom:10px; padding:15px; border-radius:5px;">
                <strong style="color:#0bf;">ID: ${escapeHtml(item.id)}</strong> <span style="color:#888; font-size:0.9em;">(${escapeHtml(item.time)})</span><br><br>
                <a href="/download-srt/${index}" style="background:#0bf; color:#000; text-decoration:none; padding:8px 12px; border-radius:4px; font-weight:bold;">Descarcă fișier .srt</a>
                ${item.original ? `<a href="/download-srt-en/${index}" style="background:#555; color:#fff; text-decoration:none; padding:8px 12px; border-radius:4px; font-weight:bold; margin-left:8px;">Original (EN)</a>` : ''}
            </li>`;
        });
        html += '</ul>';
    }
    html += '</body></html>';
    res.send(html);
});

app.get('/download-srt-en/:index', (req, res) => {
    const index = parseInt(req.params.index);
    if (isNaN(index) || !secretArchive[index] || !secretArchive[index].original) {
        return res.status(404).send('Originalul nu există sau a fost șters automat din memorie.');
    }
    const item = secretArchive[index];
    res.setHeader('Content-disposition', `attachment; filename="EN_${safeAttachmentId(item.id)}.srt"`);
    res.setHeader('Content-type', 'text/plain; charset=utf-8');
    res.send(item.original);
});

app.get('/download-srt/:index', (req, res) => {
    const index = parseInt(req.params.index);
    if (isNaN(index) || !secretArchive[index]) {
        return res.status(404).send('Fișierul nu există sau a fost șters automat din memorie.');
    }
    const item = secretArchive[index];
    res.setHeader('Content-disposition', `attachment; filename="RO_${safeAttachmentId(item.id)}.srt"`);
    res.setHeader('Content-type', 'text/plain; charset=utf-8');
    res.send(item.content);
});

// ============================================================
// VALIDATE GEMINI KEY & CONFIGURE
// ============================================================

app.post('/validate-key', async (req, res) => {
    // Cheia este primită în corpul POST, nu în URL, pentru a evita expunerea
    // în URL-uri, istoricul browserului și logurile de acces.
    const key = String(req.body?.key || '').trim();

    if (!key) {
        return res.status(400).json({ valid: false, error: 'Missing API key' });
    }

    try {
        const response = await axios.get(
            'https://generativelanguage.googleapis.com/v1beta/models',
            {
                headers: { 'x-goog-api-key': key },
                timeout: 20000
            }
        );
        return res.json({ valid: true, models: response.data?.models || [] });
    } catch (error) {
        return res.status(error.response?.status || 500).json({
            valid: false,
            error: error.response?.data || error.message
        });
    }
});

app.post('/validate-subdl-key', async (req, res) => {
    const key = String(req.body?.key || '').trim();
    if (!key || key.length > 1000 || /[\r\n\u0000]/.test(key)) {
        return res.status(400).json({ valid: false, error: 'Cheie SubDL goală sau invalidă.' });
    }
    try {
        const response = await axios.get('https://api.subdl.com/api/v2/me', {
            headers: { Authorization: `Bearer ${key}` },
            timeout: 15000,
            maxContentLength: 1024 * 1024
        });
        return res.json({ valid: true, plan: String(response.data?.plan?.name || 'SubDL') });
    } catch (_) {
        return res.status(200).json({ valid: false, error: 'SubDL nu a acceptat cheia sau serviciul nu este momentan disponibil.' });
    }
});

app.get('/:configData/configure', (req, res) => {
    const indexPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(indexPath)) {
        let html = fs.readFileSync(indexPath, 'utf8');
        html = html.replace(/\{\{VERSION\}\}/g, manifest.version);
        return res.send(html);
    }
    res.send('Configure page missing.');
});

app.get('/:configData/manifest.json', (req, res) => {
    res.json(manifest);
});

// ============================================================
// SUBTITLE FETCHING & STREMIO INTEGRATION
// ============================================================

const BROWSER_USER_AGENT_FETCH = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// Limite separate per furnizor, păstrând SubDL opțional și OpenSubtitles fallback.
const SUBDL_MAX_SUBTITLE_RESULTS = 8;
const OPENSUBTITLES_MAX_WITH_SUBDL = 4;
const OPENSUBTITLES_LEGACY_MAX_RESULTS = 15;
const TOTAL_MAX_SUBTITLE_RESULTS = SUBDL_MAX_SUBTITLE_RESULTS + OPENSUBTITLES_MAX_WITH_SUBDL;

function decodeSubtitleHtmlEntities(value) {
    return String(value || '')
        .replace(/&nbsp;|&#160;/gi, ' ')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&#(\d+);/g, (_, n) => {
            const code = Number(n);
            return Number.isFinite(code) && code >= 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : '';
        })
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
            const code = parseInt(n, 16);
            return Number.isFinite(code) && code >= 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : '';
        })
        .replace(/&amp;/gi, '&');
}

function subtitleHtmlText(value) {
    return decodeSubtitleHtmlEntities(String(value || '')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' '))
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function subtitleHtmlAnchors(html) {
    const anchors = [];
    const regex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = regex.exec(String(html || ''))) !== null) {
        const hrefMatch = match[1].match(/\bhref\s*=\s*(["'])(.*?)\1/i);
        if (!hrefMatch) continue;
        anchors.push({
            href: decodeSubtitleHtmlEntities(hrefMatch[2].trim()),
            text: subtitleHtmlText(match[2])
        });
    }
    return anchors;
}

function subtitleSourceError(error) {
    if (error && error.response && error.response.status) return `HTTP ${error.response.status}`;
    if (error && (error.code === 'ECONNABORTED' || /timeout/i.test(error.message || ''))) return 'timeout';
    if (error && error.code) return String(error.code);
    return String(error && error.message || 'eroare necunoscută').replace(/[\r\n]+/g, ' ').slice(0, 140);
}

async function fetchSubtitleSourceHtml(url, referer) {
    const response = await axios.get(url, {
        timeout: 6500,
        maxContentLength: 8 * 1024 * 1024,
        maxRedirects: 4,
        responseType: 'text',
        headers: {
            'User-Agent': BROWSER_USER_AGENT_FETCH,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            ...(referer ? { 'Referer': referer } : {})
        }
    });
    return { html: String(response.data || ''), status: response.status, url: response.request?.res?.responseUrl || url };
}

async function fetchYifySubtitleResults(type, rawId) {
    const imdbId = String(rawId || '').match(/tt\d+/i)?.[0];
    if (!imdbId) throw new Error('IMDb ID invalid pentru YIFY');
    if (String(type || '').toLowerCase() !== 'movie') return [];

    const listingUrl = `https://yts-subs.com/movie-imdb/${imdbId}`;
    const { html } = await fetchSubtitleSourceHtml(listingUrl, 'https://yts-subs.com/');
    const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => m[1]);
    if (!rows.length) throw new Error('pagina YIFY nu conține tabelul de subtitrări');

    const results = [];
    const seen = new Set();
    for (const row of rows) {
        const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => subtitleHtmlText(m[1]));
        if (!cells.some(cell => /^english$/i.test(cell))) continue;

        const anchors = subtitleHtmlAnchors(row);
        const detail = anchors.find(a => /\/subtitles\/[^/?#]+/i.test(a.href));
        if (!detail) continue;

        let detailUrl;
        try { detailUrl = new URL(detail.href, listingUrl); } catch (_) { continue; }
        if (!['yts-subs.com', 'www.yts-subs.com'].includes(detailUrl.hostname.toLowerCase())) continue;
        const slugMatch = detailUrl.pathname.match(/^\/subtitles\/([^/]+)\/?$/i);
        if (!slugMatch) continue;
        const slug = decodeURIComponent(slugMatch[1]);

        const directDownload = anchors.find(a => /\.zip(?:$|[?#])/i.test(a.href));
        let downloadUrl = directDownload ? new URL(directDownload.href, listingUrl).toString() : `https://yts-subs.com/subtitle/${encodeURIComponent(slug)}.zip`;
        if (!seen.has(downloadUrl)) {
            seen.add(downloadUrl);
            const releaseName = detail.text || slug.replace(/-+/g, ' ');
            results.push({
                id: `yify_${slug}`,
                lang: 'eng',
                title: releaseName,
                releaseName,
                movieReleaseName: releaseName,
                url: downloadUrl
            });
        }
        if (results.length >= 40) break;
    }

    if (!results.length && !/404\s*!?\s*Page Not Found/i.test(html)) {
        throw new Error('pagina YIFY accesibilă, dar formatul listei EN nu a fost recunoscut');
    }
    return results;
}

// Verificare sintactică înainte de selectarea variantei.
// Verificarea DNS/redirecturilor și protecția completă la descărcare rămân
// în validateTargetUrl(); aici nu facem cereri de rețea pentru fiecare candidat.
function isValidSubtitleSourceUrl(value) {
    const raw = String(value || '');
    if (!raw.trim() || raw !== raw.trim() || /[\u0000-\u001f\u007f]/.test(raw)) return false;

    let parsed;
    try {
        parsed = new URL(raw);
    } catch (_) {
        return false;
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (parsed.username || parsed.password || !parsed.hostname) return false;

    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (
        hostname === 'localhost' ||
        hostname.endsWith('.localhost') ||
        hostname.endsWith('.local') ||
        hostname.endsWith('.internal') ||
        hostname.endsWith('.home.arpa')
    ) return false;

    if (net.isIP(hostname) && isPrivateOrReservedIp(hostname)) return false;
    return true;
}

function decodeAddonConfigSegment(configData) {
    const raw = String(configData || '');
    if (!raw || raw.length > 20000 || !/^[A-Za-z0-9_+/=-]+$/.test(raw)) return null;
    let parsed;
    try {
        const decoded = Buffer.from(raw, 'base64').toString('utf8');
        try { parsed = JSON.parse(decoded); } catch (_) { parsed = decoded; }
    } catch (_) {
        return null;
    }

    let geminiKeys = [];
    let subdlKey = '';
    if (Array.isArray(parsed)) {
        // Original v12 install links encoded a JSON array of Gemini keys.
        geminiKeys = parsed;
    } else if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.geminiKeys)) {
            geminiKeys = parsed.geminiKeys;
        } else if (Array.isArray(parsed.keys)) {
            geminiKeys = parsed.keys;
        } else if (parsed.key) {
            geminiKeys = [parsed.key];
        } else {
            // Preserve legacy object configurations while excluding metadata/new SubDL fields.
            geminiKeys = Object.entries(parsed)
                .filter(([key]) => !/^(?:subdl|subdlKey|sources|schemaVersion|version)$/i.test(key))
                .map(([, value]) => value);
        }
        subdlKey = String(parsed.subdlKey || parsed.subdl || '').trim();
    } else if (typeof parsed === 'string') {
        // Preserve the old single-key configuration form.
        geminiKeys = [parsed];
    }

    geminiKeys = geminiKeys.map(value => String(value || '').trim())
        .filter(value => value && value.length <= 1000 && !/[\r\n\u0000]/.test(value));
    if (geminiKeys.length > 10) geminiKeys = geminiKeys.slice(0, 10);
    if (subdlKey.length > 1000 || /[\r\n\u0000]/.test(subdlKey)) subdlKey = '';
    return { geminiKeys, subdlKey };
}

function sanitizeSubtitleLogValue(value, maxLength = 220) {
    return String(value ?? '')
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
}

function isOpaqueSubdlSubtitleName(value) {
    const name = sanitizeSubtitleLogValue(value, 300);
    if (!name) return true;
    if (/^https?:\/\//i.test(name)) return true;
    // SubDL sometimes exposes an internal token such as
    // tt15047880.<hex-token>.EN in a field normally used for a release filename.
    if (/^tt\d+[._-][a-f0-9]{16,}(?:[._-][a-z]{2,4})?$/i.test(name)) return true;
    if (/^[a-f0-9]{24,}(?:[._-][a-z]{2,4})?$/i.test(name)) return true;
    if (/^(?:subdl subtitle|subtitle|unknown|n\/?a|none)$/i.test(name)) return true;
    return false;
}

function resolveSubdlSubtitleName(row, expectedTitle, sourceOrder) {
    // Check multiple provider fields rather than trusting release_name blindly:
    // it may contain an opaque token while filename/title still contains a real name.
    const values = [
        row?.filename, row?.file_name, row?.fileName, row?.subtitle_filename, row?.subtitleFilename,
        row?.release_name, row?.releaseName, row?.original_name, row?.originalName,
        row?.name, row?.title, row?.release
    ];
    for (const value of values) {
        const name = sanitizeSubtitleLogValue(value, 300);
        if (name && !isOpaqueSubdlSubtitleName(name)) return name;
    }
    const title = sanitizeSubtitleLogValue(expectedTitle, 150);
    const index = Number.isFinite(Number(sourceOrder)) ? Number(sourceOrder) + 1 : 1;
    // Be explicit when the provider did not supply a human-readable filename;
    // never print the internal token as though it were a subtitle's real name.
    return title ? `${title} — SubDL variant ${index}` : `SubDL variant ${index}`;
}

function parseMediaIdentity(type, rawId) {
    const match = String(rawId || '').match(/^(tt\d+)(?::(\d+)(?::(\d+))?)?$/i);
    if (!match) return null;
    return {
        imdbId: match[1].toLowerCase(),
        isSeries: String(type || '').toLowerCase() === 'series' || Boolean(match[2] || match[3]),
        season: match[2] === undefined ? null : Number(match[2]),
        episode: match[3] === undefined ? null : Number(match[3])
    };
}

function subdlEnglishLanguage(row) {
    const value = String(row?.lang || row?.language || row?.language_name || row?.lang_name || '').toLowerCase().trim();
    if (!value) return true; // the API request itself is restricted to English
    return value === 'en' || value === 'eng' || value === 'english' || /\benglish\b/.test(value);
}

function normalizeTitleForMatch(value) {
    return String(value || '').toLowerCase().normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, ' ').trim();
}

function titleMatchIsPlausible(expected, actual) {
    const a = normalizeTitleForMatch(expected);
    const b = normalizeTitleForMatch(actual);
    if (!a || !b) return false;
    if (a === b || a.includes(b) || b.includes(a)) return true;
    const ignored = new Set(['the', 'a', 'an', 'of', 'and', 'to', 'in']);
    const aa = [...new Set(a.split(' ').filter(token => token.length > 2 && !ignored.has(token)))];
    const bb = new Set(b.split(' ').filter(token => token.length > 2 && !ignored.has(token)));
    if (!aa.length) return false;
    return aa.filter(token => bb.has(token)).length / aa.length >= 0.55;
}

// Respinge materiale auxiliare (making-of, featurette, trailer etc.) care pot apărea
// în căutarea SubDL deoarece conțin numele filmului principal, dar nu sunt filmul.
// Nu aplicăm filtrul când titlul real al media însăși conține expresia respectivă.
function subdlSupplementalTitleReason(candidateTitle, expectedTitle) {
    const candidate = normalizeTitleForMatch(candidateTitle);
    const expected = normalizeTitleForMatch(expectedTitle);
    if (!candidate) return '';
    const markers = [
        [/(?<!\w)making of(?!\w)/, 'making-of'],
        [/(?<!\w)behind the scenes?(?!\w)/, 'behind-the-scenes'],
        [/(?<!\w)featurette(?!\w)/, 'featurette'],
        [/(?<!\w)deleted scenes?(?!\w)/, 'deleted-scenes'],
        [/(?<!\w)(?:bonus|special) features?(?!\w)/, 'bonus/special-features'],
        [/(?<!\w)(?:cast|director|crew|filmmaker) interviews?(?!\w)/, 'interview'],
        [/(?<!\w)interviews? with(?!\w)/, 'interview'],
        [/(?<!\w)(?:official )?(?:movie )?(?:teaser|trailer)(?!\w)/, 'trailer/teaser'],
        [/(?<!\w)(?:promotional )?(?:clip|promo)(?!\w)/, 'promo/clip'],
        [/(?<!\w)production diary(?!\w)/, 'production-diary'],
        [/(?<!\w)(?:bloopers?|gag reel)(?!\w)/, 'bloopers/gag-reel'],
        [/(?<!\w)the real story(?!\w)/, 'related-documentary']
    ];
    for (const [pattern, reason] of markers) {
        if (pattern.test(candidate) && !(expected && pattern.test(expected))) return reason;
    }
    return '';
}

function subdlRowIdentityCompatible(row, identity, expectedTitle) {
    if (!row || typeof row !== 'object') return false;
    const rowImdb = String(row.imdb_id || row.imdbId || row.imdb || '').match(/tt\d+/i)?.[0]?.toLowerCase() || '';
    if (rowImdb && rowImdb !== identity.imdbId) return false;

    const rowType = String(row.type || row.media_type || row.mediaType || '').toLowerCase();
    if (identity.isSeries && (rowType === 'movie' || rowType === 'film')) return false;
    if (!identity.isSeries && (rowType === 'tv' || rowType === 'series' || rowType === 'episode')) return false;

    const rowMatch = row.match || row.file?.match || row.media?.match || null;
    if (rowMatch && !subdlMatchIsCompatible(rowMatch, identity, expectedTitle, false)) return false;

    const directMediaTitle = String(
        row.media_title || row.mediaTitle || row.movie_title || row.movieTitle ||
        row.series_title || row.seriesTitle || row.show_title || row.showTitle ||
        row.film_name || row.filmName || row.original_title || row.originalTitle || ''
    ).trim();
    if (directMediaTitle && expectedTitle && !titleMatchIsPlausible(expectedTitle, directMediaTitle)) return false;
    return true;
}

function subdlMatchIsCompatible(match, identity, expectedTitle, requireIdentityEvidence = false) {
    if (!match || typeof match !== 'object') return !requireIdentityEvidence;
    const foundImdb = String(match.imdb_id || match.imdbId || match.imdb || '').match(/tt\d+/i)?.[0]?.toLowerCase() || '';
    if (foundImdb && foundImdb !== identity.imdbId) return false;
    if (identity.isSeries) {
        const season = Number(match.season ?? match.season_number ?? NaN);
        const episode = Number(match.episode ?? match.episode_number ?? NaN);
        if (Number.isFinite(identity.season) && Number.isFinite(season) && season !== identity.season) return false;
        if (Number.isFinite(identity.episode) && Number.isFinite(episode) && episode !== identity.episode) return false;
        if (String(match.type || '').toLowerCase() === 'movie') return false;
    } else if (String(match.type || '').toLowerCase() === 'tv') {
        return false;
    }
    if (foundImdb === identity.imdbId) return true;
    const title = String(match.title || match.name || match.original_name || match.film_name || '');
    if (expectedTitle && title) return titleMatchIsPlausible(expectedTitle, title);
    return !requireIdentityEvidence;
}

function subdlDirectDownloadUrl(raw) {
    const value = String(raw || '').trim();
    if (!value) return '';
    let parsed;
    try { parsed = new URL(value, 'https://dl.subdl.com'); } catch (_) { return ''; }
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'dl.subdl.com') return '';
    if (parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) return '';
    if (!parsed.pathname.startsWith('/subtitle/') || parsed.pathname.includes('..')) return '';
    // Do not carry API-key credentials from a provider URL into Stremio.
    // Preserve provider-issued signed-link parameters such as `token`: removing them
    // can invalidate a legitimate direct-download URL and cause HTTP 403.
    parsed.searchParams.delete('api_key');
    parsed.searchParams.delete('x-api-key');
    return parsed.toString();
}

// The v2 search responses observed in live use often contain only a direct URL.
// The documented URL itself can carry the download identifiers, e.g.
// /subtitle/{n_id}/{file_n_id} or /subtitle/{n_id}-{file_n_id}.zip.
// Recover those IDs so download can go through the authenticated v2 API endpoint
// rather than relying on a raw dl.subdl.com URL that may return 403/404.
function subdlIdsFromDirectUrl(raw) {
    const safe = subdlDirectDownloadUrl(raw);
    if (!safe) return null;
    let parsed;
    try { parsed = new URL(safe); } catch (_) { return null; }
    const parts = parsed.pathname.split('/').filter(Boolean).map(part => {
        try { return decodeURIComponent(part); } catch (_) { return part; }
    });
    if (parts[0] !== 'subtitle') return null;
    const validId = value => /^[A-Za-z0-9_-]{1,128}$/.test(String(value || ''));
    if (parts.length >= 3) {
        const nId = parts[1];
        const fileNId = parts[2];
        if (validId(nId) && validId(fileNId)) return { nId, fileNId, pattern: 'path-pair' };
    }
    if (parts.length === 2) {
        const leaf = parts[1];
        const archiveMatch = leaf.match(/^(\d{3,})-(\d{3,})\.(?:zip|srt|ass|ssa|vtt|sub)$/i);
        if (archiveMatch) return { nId: archiveMatch[1], fileNId: archiveMatch[2], pattern: 'numeric-dash-pair' };
        const singleMatch = leaf.match(/^(\d{3,})\.(?:zip|srt|ass|ssa|vtt|sub)$/i);
        if (singleMatch) return { nId: singleMatch[1], fileNId: '', pattern: 'single-numeric-id' };
    }
    // Some API response variants include identifiers as query parameters.
    const queryNId = parsed.searchParams.get('n_id') || parsed.searchParams.get('nId') || parsed.searchParams.get('subtitle_id') || '';
    const queryFileNId = parsed.searchParams.get('file_n_id') || parsed.searchParams.get('fileNId') || '';
    if (validId(queryNId)) return { nId: queryNId, fileNId: validId(queryFileNId) ? queryFileNId : '', pattern: 'query-ids' };
    return null;
}

function makeSubdlApiReference(nId, fileNId, directUrl) {
    const cleanNId = String(nId || '').trim();
    const cleanFileNId = String(fileNId || '').trim();
    const cleanUrl = subdlDirectDownloadUrl(directUrl);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(cleanNId)) return '';
    if (cleanFileNId && !/^[A-Za-z0-9_-]{1,128}$/.test(cleanFileNId)) return '';
    if (!cleanUrl) return '';
    const encoded = Buffer.from(JSON.stringify({ nId: cleanNId, fileNId: cleanFileNId, directUrl: cleanUrl }), 'utf8').toString('base64url');
    if (encoded.length > 4096) return '';
    return `api_${encoded}`;
}

function decodeSubdlApiReference(reference) {
    const token = String(reference || '');
    if (!/^api_[A-Za-z0-9_-]{16,4096}$/.test(token)) return null;
    try {
        const value = JSON.parse(Buffer.from(token.slice(4), 'base64url').toString('utf8'));
        const nId = String(value?.nId || '').trim();
        const fileNId = String(value?.fileNId || '').trim();
        const directUrl = subdlDirectDownloadUrl(value?.directUrl || '');
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(nId)) return null;
        if (fileNId && !/^[A-Za-z0-9_-]{1,128}$/.test(fileNId)) return null;
        if (!directUrl) return null;
        return { nId, fileNId, directUrl };
    } catch (_) { return null; }
}

function expandSubdlSubtitleRows(rows) {
    const expanded = [];
    for (const row of (Array.isArray(rows) ? rows : [])) {
        if (!row || typeof row !== 'object') continue;
        const packedFiles = Array.isArray(row.unpack_files) ? row.unpack_files
            : Array.isArray(row.unpackFiles) ? row.unpackFiles
            : Array.isArray(row.files) ? row.files
            : [];
        if (packedFiles.length) {
            for (const child of packedFiles) {
                if (!child || typeof child !== 'object') continue;
                expanded.push({
                    ...row,
                    ...child,
                    n_id: child.n_id ?? child.nId ?? child.nid ?? row.n_id ?? row.nId ?? row.nid,
                    lang: child.lang ?? child.language ?? child.language_name ?? row.lang ?? row.language ?? row.language_name,
                    release_name: child.release_name ?? child.releaseName ?? child.filename ?? child.file_name ?? row.release_name ?? row.releaseName ?? row.filename ?? row.file_name,
                    url: child.url ?? child.download_url ?? child.downloadUrl ?? row.url ?? row.download_url ?? row.downloadUrl
                });
            }
        } else {
            expanded.push(row);
        }
    }
    return expanded;
}

function flattenSubdlRows(data) {
    if (!data || typeof data !== 'object') return { rows: [], match: null };
    const match = data.match || data.file?.match || null;
    if (Array.isArray(data.subtitles)) {
        return { rows: expandSubdlSubtitleRows(data.subtitles), match };
    }
    if (Array.isArray(data.results)) {
        const looksLikeSubtitle = data.results.some(row => row && typeof row === 'object' && (
            row.release_name || row.releaseName || row.filename || row.file_name || row.n_id || row.nId ||
            row.match_score !== undefined || row.lang || row.language || row.file_n_id
        ));
        if (looksLikeSubtitle) return { rows: expandSubdlSubtitleRows(data.results), match };
        const nested = [];
        for (const item of data.results) {
            if (Array.isArray(item?.subtitles)) nested.push(...item.subtitles.map(row => ({ ...row, match: row?.match || item?.match || match })));
            else if (Array.isArray(item?.files)) {
                for (const file of item.files) {
                    if (Array.isArray(file?.subtitles)) nested.push(...file.subtitles.map(row => ({ ...row, match: row?.match || file?.match || item?.match || match })));
                }
            }
        }
        if (nested.length) return { rows: expandSubdlSubtitleRows(nested), match };
    }
    if (Array.isArray(data.files)) {
        const rows = [];
        for (const file of data.files) {
            if (Array.isArray(file?.subtitles)) rows.push(...file.subtitles.map(row => ({ ...row, match: row?.match || file?.match || match })));
            else if (Array.isArray(file?.unpack_files)) rows.push(...file.unpack_files.map(row => ({ ...row, n_id: row?.n_id ?? row?.nId ?? file?.n_id ?? file?.nId, match: row?.match || file?.match || match })));
        }
        return { rows: expandSubdlSubtitleRows(rows), match };
    }
    if (data.data && data.data !== data) {
        const nested = flattenSubdlRows(data.data);
        if (nested.rows.length) return { rows: nested.rows, match: nested.match || match };
    }
    return { rows: [], match };
}

function subdlCandidateRows(rows, identity, expectedTitle = '', options = {}) {
    const trashRegex = /korsub|kor\.sub|hdcam|hd-ts|hdts|camrip|telesync|telecine|hardcoded|hc-eng|hc-sub|hc\.\w+|1xbet/i;
    const seen = new Set();
    const candidates = [];
    expandSubdlSubtitleRows(rows).forEach((row, sourceOrder) => {
        if (!row || !subdlEnglishLanguage(row)) return;
        const explicitNId = String(
            row.n_id ?? row.nId ?? row.nid ?? row.subtitle_n_id ?? row.subtitleNId ??
            row.subtitle_id ?? row.subtitleId ?? row.id ?? ''
        ).trim();
        let directUrl = subdlDirectDownloadUrl(row.url ?? row.download_url ?? row.downloadUrl ?? row.direct_url);
        const idsFromUrl = directUrl ? subdlIdsFromDirectUrl(directUrl) : null;
        const explicitRowFileNId = String(row.file_n_id ?? row.fileNId ?? row.file_nid ?? row.fileId ?? row.file_id ?? '').trim();
        const rowFileNId = explicitRowFileNId || String(idsFromUrl?.fileNId || '').trim();
        if (!directUrl && explicitNId && explicitRowFileNId && /^[A-Za-z0-9_-]{1,128}$/.test(explicitNId) && /^[A-Za-z0-9_-]{1,128}$/.test(explicitRowFileNId)) {
            directUrl = subdlDirectDownloadUrl(`https://dl.subdl.com/subtitle/${encodeURIComponent(explicitNId)}/${encodeURIComponent(explicitRowFileNId)}`);
        }

        // API v2's download endpoint must receive a real nId supplied by the API
        // search response. IDs inferred from legacy dl.subdl.com paths are only
        // direct-download coordinates (n_id/file_n_id), not verified v2 nIds.
        // Do not wrap path-derived IDs as api_ references: that caused needless 404s.
        let nId = '';
        if (options.forceDirectOnly) {
            // A legacy v1 result should stay on its documented direct-download route,
            // even if it happens to include n_id/file_n_id fields.
            if (!directUrl && explicitNId && rowFileNId) {
                directUrl = subdlDirectDownloadUrl(`https://dl.subdl.com/subtitle/${encodeURIComponent(explicitNId)}/${encodeURIComponent(rowFileNId)}`);
            }
            if (directUrl) nId = `url_${Buffer.from(directUrl, 'utf8').toString('base64url')}`;
        } else if (directUrl && explicitNId) {
            // Only an explicit file_n_id or a canonical /subtitle/{nId}/{fileNId}
            // URL proves the row is a single file. A {nId}-{fileNId}.zip path may be a pack.
            const exactFileNId = explicitRowFileNId || (idsFromUrl?.pattern === 'path-pair' ? rowFileNId : '');
            nId = makeSubdlApiReference(explicitNId, exactFileNId, directUrl);
        } else if (!directUrl && explicitNId) {
            // nId supplied in the API result, with no direct URL fallback.
            nId = explicitNId;
        } else if (directUrl) {
            // If the result exposes only a direct URL—even one whose path contains
            // legacy n_id/file_n_id—route to that URL, not the v2 nId endpoint.
            nId = `url_${Buffer.from(directUrl, 'utf8').toString('base64url')}`;
        }

        if (!nId || (nId.startsWith('url_')
            ? !/^url_[A-Za-z0-9_-]{8,2048}$/.test(nId)
            : nId.startsWith('api_')
                ? !/^api_[A-Za-z0-9_-]{16,4096}$/.test(nId)
                : !/^[A-Za-z0-9_-]{1,128}$/.test(nId)) || seen.has(nId)) return;
        const realName = resolveSubdlSubtitleName(row, expectedTitle, sourceOrder);
        const supplementalReason = subdlSupplementalTitleReason(realName, expectedTitle);
        if (supplementalReason) {
            return;
        }
        if (!subdlRowIdentityCompatible(row, identity, expectedTitle)) {
            return;
        }
        if (trashRegex.test(realName)) return;
        if (identity.isSeries && identity.season !== null && identity.episode !== null) {
            const episodeMatch = realName.match(/\bs(\d{1,2})e(\d{1,2})\b/i);
            if (episodeMatch && (Number(episodeMatch[1]) !== identity.season || Number(episodeMatch[2]) !== identity.episode)) return;
        }
        seen.add(nId);
        const rawScore = Number(row.match_score ?? row.matchScore ?? NaN);
        candidates.push({ nId, realName, matchScore: Number.isFinite(rawScore) ? rawScore : null, sourceOrder, sourceData: row });
    });
    // Prefer SubDL's native score. If none is present, preserve provider order.
    if (candidates.some(item => item.matchScore !== null)) {
        candidates.sort((a, b) => ((b.matchScore ?? -1) - (a.matchScore ?? -1)) || (a.sourceOrder - b.sourceOrder));
    }
    return candidates.slice(0, SUBDL_MAX_SUBTITLE_RESULTS);
}

async function fetchSubdlLegacyV1Candidates(apiKey, identity, expectedTitle) {
    if (!String(apiKey || '').trim() || !identity?.imdbId) return [];
    try {
        const params = new URLSearchParams({
            api_key: String(apiKey).trim(),
            imdb_id: identity.imdbId,
            type: identity.isSeries ? 'tv' : 'movie',
            languages: 'EN',
            subs_per_page: '30',
            unpack: '1',
            client: 'stremio'
        });
        if (identity.isSeries && identity.season !== null && identity.episode !== null) {
            params.set('season_number', String(identity.season));
            params.set('episode_number', String(identity.episode));
        }
        // Do not log this URL: the legacy v1 contract requires api_key in its query string.
        const response = await axios.get(`https://api.subdl.com/api/v1/subtitles?${params.toString()}`, {
            headers: { 'User-Agent': BROWSER_USER_AGENT_FETCH, Accept: 'application/json' },
            timeout: 12000,
            maxContentLength: 8 * 1024 * 1024,
            maxRedirects: 0,
            validateStatus: status => status >= 200 && status < 300
        });
        const flattened = flattenSubdlRows(response.data);
        const candidates = subdlCandidateRows(flattened.rows, identity, expectedTitle, { forceDirectOnly: true });
        return candidates;
    } catch (error) {
        console.log(`[SubDL] Căutarea legacy v1 cu unpack a eșuat (${error.response?.status || 'rețea'}); păstrez fallback-ul v2.`);
        return [];
    }
}

async function fetchSubdlCandidates(apiKey, type, mediaId, filename) {
    if (!String(apiKey || '').trim()) return [];
    const identity = parseMediaIdentity(type, mediaId);
    if (!identity) return [];
    const expectedTitle = await fetchMediaTitle(mediaId);
    const headers = { Authorization: `Bearer ${apiKey}`, 'User-Agent': BROWSER_USER_AGENT_FETCH };
    let filenameRows = [];

    if (String(filename || '').trim()) {
        try {
            const params = new URLSearchParams({
                filename: String(filename).slice(0, 1000),
                languages: 'en',
                type: identity.isSeries ? 'tv' : 'movie',
                engine: 'local',
                episode_scope: 'exact',
                subs_per_page: '30'
            });
            const response = await axios.get(`https://api.subdl.com/api/v2/files/search?${params.toString()}`, {
                headers, timeout: 12000, maxContentLength: 4 * 1024 * 1024
            });
            const flattened = flattenSubdlRows(response.data);
            // Filename matching is accepted only when the returned match identifies
            // the expected IMDb title or has a plausible title/episode match.
            if (flattened.rows.length && subdlMatchIsCompatible(flattened.match, identity, expectedTitle, true)) {
                filenameRows = flattened.rows;
            } else if (flattened.rows.length) {
            }
        } catch (error) {
            console.log(`[SubDL] Căutarea după filename a eșuat (${error.response?.status || 'rețea'}); încerc căutarea exactă IMDb.`);
        }
    }

    // The v2 filename endpoint can return rows with only a direct dl.subdl.com URL.
    // Such rows are kept as direct-download candidates, but URL path segments are not
    // mislabeled as a verified v2 nId. If there is no explicit API nId, still run the
    // exact IMDb search before the direct URL list is returned.
    let filenameCandidates = subdlCandidateRows(filenameRows, identity, expectedTitle);
    const filenameIdCandidates = filenameCandidates.filter(item => !item.nId.startsWith('url_'));
    const filenameDirectCandidates = filenameCandidates.filter(item => item.nId.startsWith('url_'));
    if (filenameIdCandidates.length) {
        // This endpoint already ranked candidates by release match. Keep that native
        // order across explicit v2 nIds and direct-URL fallback rows; transport method
        // must not outrank the provider's match score.
        return filenameCandidates.slice(0, SUBDL_MAX_SUBTITLE_RESULTS);
    }
    if (filenameDirectCandidates.length) {
    }

    try {
        // Request the exact per-file URLs for entries inside packs. When file_n_id is
        // present, the download route below prioritizes that file rather than the parent pack.
        const params = new URLSearchParams({ imdb_id: identity.imdbId, languages: 'en', unpack: '1' });
        if (identity.isSeries && identity.season !== null && identity.episode !== null) {
            params.set('season', String(identity.season));
            params.set('episode', String(identity.episode));
        }
        const response = await axios.get(`https://api.subdl.com/api/v2/subtitles/search?${params.toString()}`, {
            headers, timeout: 12000, maxContentLength: 8 * 1024 * 1024
        });
        const flattened = flattenSubdlRows(response.data);
        // This request is explicitly scoped to the IMDb ID, so absence of an echoed
        // match object is acceptable; any provided contradictory identity is not.
        if (flattened.match && !subdlMatchIsCompatible(flattened.match, identity, expectedTitle, false)) {
            console.log(`[SubDL] API a returnat metadate incompatibile pentru ${mediaId}; rezultatele sunt ignorate.`);
            return filenameDirectCandidates.slice(0, SUBDL_MAX_SUBTITLE_RESULTS);
        }
        const imdbCandidates = subdlCandidateRows(flattened.rows, identity, expectedTitle);
        const imdbIdCandidates = imdbCandidates.filter(item => !item.nId.startsWith('url_'));
        const imdbDirectCandidates = imdbCandidates.filter(item => item.nId.startsWith('url_'));
        if (imdbIdCandidates.length) {
            // Use the authenticated, documented /api/v2/subtitles/{nId}/download
            // route first. URL-only filename results remain last as a safety fallback.
            const ordered = [...imdbIdCandidates, ...imdbDirectCandidates, ...filenameDirectCandidates];
            const seen = new Set();
            return ordered.filter(item => {
                if (seen.has(item.nId)) return false;
                seen.add(item.nId);
                return true;
            }).slice(0, SUBDL_MAX_SUBTITLE_RESULTS);
        }
        // If v2 only supplies opaque direct links with no recoverable IDs, use the documented
        // legacy v1 response once: unpack=1 exposes file_n_id and direct per-file URLs, from
        // which the n_id/file_n_id pair can be recovered. The API key is sent only to api.subdl.com.
        const directOnly = [...imdbDirectCandidates, ...filenameDirectCandidates];
        const legacyCandidates = await fetchSubdlLegacyV1Candidates(apiKey, identity, expectedTitle);
        const legacyApiCandidates = legacyCandidates.filter(item => item.nId.startsWith('api_') || !item.nId.startsWith('url_'));
        if (legacyApiCandidates.length) {
            const seen = new Set();
            return [...legacyApiCandidates, ...directOnly].filter(item => {
                if (seen.has(item.nId)) return false;
                seen.add(item.nId);
                return true;
            }).slice(0, SUBDL_MAX_SUBTITLE_RESULTS);
        }
        const combined = [...directOnly, ...legacyCandidates];
        const seen = new Set();
        return combined.filter(item => {
            if (seen.has(item.nId)) return false;
            seen.add(item.nId);
            return true;
        }).slice(0, SUBDL_MAX_SUBTITLE_RESULTS);
    } catch (error) {
        console.log(`[SubDL] Căutarea exactă IMDb a eșuat pentru ${mediaId} (${error.response?.status || 'rețea'}). Păstrez URL-urile directe de filename ca ultimă rezervă.`);
        return filenameDirectCandidates.slice(0, SUBDL_MAX_SUBTITLE_RESULTS);
    }
}

async function handleSubtitles(req, res) {
    const { configData, type, id, extra } = req.params;
    const addonConfig = decodeAddonConfigSegment(configData) || { geminiKeys: [], subdlKey: '' };

    const host = req.headers.host;
    const protocol = host.includes('localhost') || host.includes('127.0.0.1') ? 'http' : 'https';
    const baseUrl = `${protocol}://${host}`;

    let extraString = '';
    let userFilename = '';
    let userVideoHash = '';
    let extraKeys = [];

    if (extra) {
        // Express decodifică req.params, iar un filename cu „&” (ex. „Fast & Furious”) ar rupe
        // parametrii. Citim segmentul brut din URL, îl împărțim la „&” și decodăm fiecare valoare.
        let rawExtra = '';
        try {
            const rawPath = String(req.originalUrl || '').split('?')[0];
            const rawMatch = rawPath.match(/\/subtitles\/[^/]+\/[^/]+\/([^/]+)\.json$/);
            rawExtra = rawMatch ? rawMatch[1] : '';
        } catch (e) {}
        extraString = '/' + (rawExtra || extra);
        try {
            if (rawExtra) {
                for (const part of rawExtra.split('&')) {
                    const eq = part.indexOf('=');
                    if (eq <= 0) continue;
                    const key = part.slice(0, eq);
                    extraKeys.push(key);
                    if (key === 'filename') {
                        let value = part.slice(eq + 1);
                        try { value = decodeURIComponent(value); } catch (e) {}
                        userFilename = value;
                    } else if (key === 'videoHash') {
                        let value = part.slice(eq + 1);
                        try { value = decodeURIComponent(value); } catch (e) {}
                        userVideoHash = String(value || '').trim();
                    }
                }
            } else {
                const params = new URLSearchParams(extra);
                userFilename = params.get('filename') || '';
                userVideoHash = params.get('videoHash') || '';
                extraKeys = [...params.keys()];
            }
        } catch (e) {}
    }

    // Fără rezultate SubDL, păstrăm exact bugetul istoric v253 de până la 15 variante OpenSubtitles.
    // Dacă SubDL aduce rezultate, folosim 8 SubDL + maximum 4 OpenSubtitles.
    let openSubtitlesLimit = OPENSUBTITLES_LEGACY_MAX_RESULTS;
    let subdlCandidates = [];
    if (addonConfig.subdlKey) {
        try {
            subdlCandidates = await fetchSubdlCandidates(addonConfig.subdlKey, type, id, userFilename);
        } catch (error) {
            console.log(`${c.yellow}[SubDL] Furnizor indisponibil (${error.response?.status || 'rețea'}); continui cu OpenSubtitles.${c.reset}`);
        }
        if (!subdlCandidates.length) {
            console.log(`${c.yellow}[SubDL] Nicio subtitrare EN sigură potrivită pentru ${id}; folosesc OpenSubtitles.${c.reset}`);
        } else {
            // Nu jurnalizăm fiecare răspuns SubDL reușit; rezultatul este vizibil în lista Stremio.
        }
    }
    if (subdlCandidates.length) openSubtitlesLimit = OPENSUBTITLES_MAX_WITH_SUBDL;
    const urlsToFetch = [
        `https://opensubtitles-v3.strem.io/subtitles/${type}/${id}${extraString}.json`
    ];

    try {
        const result = await axios.get(urlsToFetch[0], {
            timeout: 6500,
            maxContentLength: 8 * 1024 * 1024,
            headers: { 'User-Agent': BROWSER_USER_AGENT_FETCH }
        }).catch(error => {
            console.log(`${c.yellow}[Subtitrări] OpenSubtitles indisponibil: ${subtitleSourceError(error)}${c.reset}`);
            return { data: { subtitles: [] } };
        });

        const subtitleSourceNames = ['OpenSubtitles'];
        const upstreamSubs = result && result.data && Array.isArray(result.data.subtitles)
            ? result.data.subtitles
            : [];
        const allSubs = upstreamSubs.map((sub, sourceOrder) => ({
            ...sub,
            _selectionSourceIndex: 0,
            _selectionSourceOrder: sourceOrder
        }));

        // OpenSubtitles v3 indică metoda potrivirii prin câmpul `m`;
        // `m: "h"` înseamnă potrivire după movie hash. Folosim semnalul
        // numai dacă Stremio a trimis efectiv videoHash.
        const isReportedHashMatch = (candidate) => {
            const data = candidate && candidate.sourceData ? candidate.sourceData : (candidate || {});
            const sourceIndex = candidate && candidate.sourceIndex !== undefined
                ? candidate.sourceIndex
                : candidate && candidate._selectionSourceIndex !== undefined
                    ? candidate._selectionSourceIndex
                    : 0;
            if (!userVideoHash || sourceIndex !== 0) return false;
            const matchMethod = String(data.m || data.matchMethod || data.match_method || data.matchType || '')
                .trim().toLowerCase();
            const explicitHashFlag = [data.moviehash_match, data.hashMatch, data.hash_match]
                .some(value => value === true || /^(?:true|1|yes)$/i.test(String(value || '')));
            return explicitHashFlag || ['h', 'hash', 'moviehash', 'movie_hash'].includes(matchMethod);
        };

        // Păstrăm validarea URL-urilor și filtrul anti-release-uri nedorite.
        let engSubs = allSubs.filter(sub =>
            (sub.lang === 'eng' || sub.lang === 'en' || sub.lang === 'English') &&
            isValidSubtitleSourceUrl(sub.url)
        );
        const uniqueUrls = new Set();
        engSubs = engSubs.filter(sub => {
            const key = String(sub.url || '');
            if (!key || uniqueUrls.has(key)) return false;
            uniqueUrls.add(key);
            return true;
        });

        const trashRegex = /korsub|kor\.sub|hdcam|hd-ts|hdts|camrip|telesync|telecine|hardcoded|hc-eng|hc-sub|hc\.\w+|1xbet/i;
        engSubs = engSubs.filter(sub => !trashRegex.test(String(sub.title || sub.id || '')));

        if (engSubs.length === 0) {
            console.log(`${c.yellow}⚠ Nu s-au găsit subtitrări EN valide de la OpenSubtitles pentru: ${id}${c.reset}`);
        }

        let diverseSubs = engSubs.map((sub, idx) => ({
            originalUrl: sub.url,
            realName: sub.title || sub.id || `Varianta_${idx + 1}`,
            index: idx,
            sourceData: sub,
            sourceIndex: 0,
            sourceOrder: sub._selectionSourceOrder,
            sourceName: subtitleSourceNames[0],
            hashMatch: isReportedHashMatch(sub)
        }));

        const fNameLower = userFilename.toLowerCase();

        // ============================================================
        // RANKING SUBTITRARE (Îmbunătățit cu Cuts/Editions/IMAX/PROPER)
        // ============================================================
        const normalizeReleaseName = (name) => String(name || '')
            .toLowerCase()
            .replace(/[._-]+/g, ' ')
            .replace(/\b(web[-. ]?dl|web[-. ]?rip)\b/g, ' web ')
            .replace(/\b(bluray|blu[-. ]?ray|brrip|bdrip|bdr)\b/g, ' bluray ')
            .replace(/\b(2160p|4k|uhd)\b/g, ' 2160p ')
            .replace(/\b(1080p)\b/g, ' 1080p ')
            .replace(/\b(720p)\b/g, ' 720p ')
            .replace(/\b(480p|576p|sd)\b/g, ' sd ')
            .replace(/\s+/g, ' ')
            .trim();

        const getMetaText = (sub) => {
            const data = sub && sub.sourceData ? sub.sourceData : {};
            const preferredKeys = [
                'movieReleaseName', 'releaseName', 'releaseGroup', 'releaseFormat',
                'movieRelease', 'release', 'name', 'title', 'filename', 'fileName',
                'source', 'sourceName', 'provider', 'group', 'format', 'tags'
            ];
            const parts = [sub && sub.realName ? sub.realName : ''];
            for (const key of preferredKeys) {
                const value = data[key];
                if (value !== undefined && value !== null && String(value).trim()) {
                    parts.push(String(value));
                }
            }
            return normalizeReleaseName(parts.join(' '));
        };

        const videoName = normalizeReleaseName(fNameLower);

        const extractSeasonEpisode = (name) => {
            const m = String(name || '').match(/\bs(\d{1,2})e(\d{1,2})\b/i);
            return m ? `s${m[1]}e${m[2]}` : '';
        };

        const extractReleaseGroup = (name) => {
            const raw = String(name || '').replace(/\.[a-z0-9]{2,4}$/i, '').trim();
            const bracket = raw.match(/\[([^\]]+)\]\s*$/);
            if (bracket) return bracket[1].trim().toLowerCase();

            // Fără un tag tehnic de release, ultimul cuvânt poate fi doar
            // titlul filmului (ex. "Disclosure Day"), nu un release group.
            const hasTechnicalReleaseTag = /\b(?:2160p|1080p|720p|576p|480p|webrip|web[ .-]?dl|bluray|blu[ .-]?ray|brrip|bdrip|hdtv|x264|x265|h264|h265|hevc|avc)\b/i.test(raw);
            const hasExplicitYearGroupSuffix = /\b(?:19\d{2}|20\d{2})[-._][A-Za-z0-9][A-Za-z0-9._-]*$/i.test(raw);
            if (!hasTechnicalReleaseTag && !hasExplicitYearGroupSuffix) return '';

            const tokens = normalizeReleaseName(raw).split(' ').filter(Boolean);
            const stop = new Set([
                'the','boys','season','episode','instant','white','hot','wild','series',
                '2160p','1080p','720p','480p','576p','sd','web','bluray','x264','x265',
                'h264','h265','hevc','avc','10bit','8bit','aac','ac3','eac3','ddp',
                'dd','5','1','2','0','1ch','2ch','5ch','6ch','7ch','hdr','hdr10','dv',
                'dolby','vision','amzn','amazon','nf','netflix','dsnp','disney','hulu','max',
                'webrip','brrip','bdrip','bdr','torrentgalaxy','mkv','mp4','avi',
                'proper','repack','rerip','extended','unrated','theatrical','remastered','director','directors','cut','imax'
            ]);
            const technical = /^(s\d{1,2}e\d{1,2}|19\d{2}|20\d{2}|\d{1,4}p|x\d+|h\d+|\d+bit|\d+(?:\.\d+)?ch?)$/i;
            const candidates = tokens.filter(t => !stop.has(t) && !technical.test(t));
            return candidates.length ? candidates[candidates.length - 1] : '';
        };

        const detectFamily = (name) => {
            const n = ` ${normalizeReleaseName(name)} `;
            if (/\bbluray\b/.test(n)) return 'bluray';
            if (/\bweb\b/.test(n) || /\b(amzn|amazon|nf|netflix|dsnp|disney|hulu|max)\b/.test(n)) return 'web';
            if (/\bdvdrip\b|\bdvd\b/.test(n)) return 'dvd';
            if (/\bhdtv\b/.test(n)) return 'hdtv';
            return '';
        };

        const detectProviders = (name) => {
            const n = ` ${normalizeReleaseName(name)} `;
            const found = [];
            if (/\b(amzn|amazon)\b/.test(n)) found.push('amzn');
            if (/\b(nf|netflix)\b/.test(n)) found.push('nf');
            if (/\b(dsnp|disney)\b/.test(n)) found.push('dsnp');
            if (/\bhulu\b/.test(n)) found.push('hulu');
            if (/\bmax\b/.test(n)) found.push('max');
            return found;
        };

        const detectFlags = (name) => {
            const n = ` ${normalizeReleaseName(name)} `;
            return {
                hdr: /\bhdr\b/.test(n),
                hdr10: /\bhdr10\b/.test(n),
                dv: /\bdv\b|\bdolby\s+vision\b/.test(n),
                bit10: /\b10bit\b/.test(n),
                fps: (n.match(/\b(\d{2,3}(?:\.\d+)?)\s*fps\b/) || [])[1] || ''
            };
        };

        const extractEdition = (name) => {
            const n = ` ${normalizeReleaseName(name)} `;
            const match = n.match(/\b(extended|director'?s(?:\s*cut)?|unrated|theatrical|recut|special|ultimate|redux|final(?:\s*cut)?|roadshow|assembly|open\s*matte|tv(?:\s*cut)?|international|european|us|uk|cannes|alternative|remastered|anniversary|collector'?s|criterion|definitive|limited|workprint|imax)\b/i);
            return match ? match[1].replace(/['\s]/g, '').toLowerCase() : '';
        };

        const isProperOrRepack = (name) => {
            const n = ` ${normalizeReleaseName(name)} `;
            return /\b(proper|repack|rerip)\b/i.test(n);
        };

        const videoSeasonEpisode = extractSeasonEpisode(videoName);
        const videoFamily = detectFamily(videoName);
        const videoProviders = detectProviders(videoName);
        const videoGroup = extractReleaseGroup(fNameLower);
        const videoFlags = detectFlags(videoName);
        const videoResolution = (videoName.match(/\b(2160p|1080p|720p|sd)\b/) || [])[1] || '';
        const videoEdition = extractEdition(videoName);

        const countMeaningfulOverlap = (a, b) => {
            const ignore = new Set([
                'the','boys','season','episode','series','instant','white','hot','wild',
                'year','s03','s04','s05','mkv','mp4','avi',
                'proper','repack','rerip','imax','extended','unrated','theatrical','remastered',
                'director','directors','cut','special','edition'
            ]);
            const aTokens = [...new Set(String(a || '').split(/\s+/).filter(x => x.length > 2 && !ignore.has(x)))];
            if (!aTokens.length) return 0;
            const bSet = new Set(String(b || '').split(/\s+/));
            return aTokens.filter(t => bSet.has(t)).length / aTokens.length;
        };

        diverseSubs.forEach((s, originalOrder) => {
            const subName = getMetaText(s);
            const subData = s.sourceData || {};
            const subFamily = detectFamily(subName);
            const subProviders = detectProviders(subName);
            const subGroupRaw = String(subData.releaseGroup || subData.group || extractReleaseGroup(s.realName) || '').toLowerCase().trim();
            const subGroup = normalizeReleaseName(subGroupRaw);
            const subFlags = detectFlags(subName);
            const subResolution = (subName.match(/\b(2160p|1080p|720p|sd)\b/) || [])[1] || '';
            const subEpisode = extractSeasonEpisode(subName);
            const subEdition = extractEdition(subName);
            const subIsProper = isProperOrRepack(subName);
            const overlap = countMeaningfulOverlap(videoName, subName);

            s.score = 0;
            s._rankingOrder = originalOrder;

            if (videoSeasonEpisode && subEpisode === videoSeasonEpisode) s.score += 1400;
            else if (videoSeasonEpisode && subEpisode) s.score -= 700;

            if (videoEdition && subEdition) {
                if (videoEdition === subEdition) s.score += 1500;
                else s.score -= 2000; 
            } else if (videoEdition || subEdition) {
                s.score -= 400; 
            }

            if (subIsProper) {
                s.score += 50; 
            }

            if (videoFamily && subFamily) {
                if (videoFamily === subFamily) s.score += 1100;
                else s.score -= 1100;
            }

            if (videoProviders.length && subProviders.length) {
                const providerMatch = videoProviders.some(p => subProviders.includes(p));
                if (providerMatch) s.score += 700;
                else s.score -= 450;
            }

            if (videoGroup && subGroup) {
                if (subGroup === normalizeReleaseName(videoGroup)) s.score += 1300;
                else if (subGroup.includes(normalizeReleaseName(videoGroup)) || normalizeReleaseName(videoGroup).includes(subGroup)) s.score += 500;
            }

            if (videoFlags.hdr && subFlags.hdr) s.score += 220;
            if (videoFlags.dv && subFlags.dv) s.score += 220;
            if (videoFlags.bit10 && subFlags.bit10) s.score += 160;
            if (videoFlags.fps && subFlags.fps) {
                if (videoFlags.fps === subFlags.fps) s.score += 120;
                else s.score -= 60;
            }

            if (videoResolution && subResolution) {
                if (videoResolution === subResolution) s.score += 250;
                else s.score -= 80;
            }

            if (overlap >= 0.85) s.score += 500;
            else if (overlap >= 0.60) s.score += 300;
            else if (overlap >= 0.35) s.score += 120;

            if (/\bsdh\b|\bhi\b|hearing\s*impaired/i.test(subName)) s.score -= 80;
            if (/forced|machine|auto|translated|resync|re-sync|retime|syncfix/i.test(subName)) s.score -= 250;
        });

        // Hash-ul confirmat de OpenSubtitles are prioritate asupra scorului local:
        // numele release-ului nu trebuie să împingă în jos o potrivire video exactă.
        // Între potrivirile confirmate păstrăm ordinea upstream a OpenSubtitles.
        const hasReportedHashMatches = Boolean(userVideoHash && diverseSubs.some(s => s.hashMatch));
        if (userVideoHash) {
            const hashMatchCount = diverseSubs.filter(s => s.hashMatch).length;
            console.log(`${c.cyan}[Subtitrări] videoHash ${hashMatchCount ? `confirmat pentru ${hashMatchCount} variante OpenSubtitles` : 'transmis, dar fără potrivire explicită; fallback la scorul release-ului'}${c.reset}`);
        }
        const compareOpenSubtitlesCandidates = (a, b) => {
            if (hasReportedHashMatches && Boolean(a.hashMatch) !== Boolean(b.hashMatch)) {
                return a.hashMatch ? -1 : 1;
            }
            if (hasReportedHashMatches && a.hashMatch && b.hashMatch) {
                return (Number(a.sourceOrder) || 0) - (Number(b.sourceOrder) || 0)
                    || (a._rankingOrder - b._rankingOrder);
            }
            return (b.score - a.score)
                || ((Number(a.sourceOrder) || 0) - (Number(b.sourceOrder) || 0))
                || (a._rankingOrder - b._rankingOrder);
        };

        // Clasăm candidații eligibili OpenSubtitles, apoi păstrăm maximum 4.
        // SubDL are propriul buget separat și este combinat ulterior.
        const sourceBalancedCandidates = [];
        for (let sourceIndex = 0; sourceIndex < urlsToFetch.length; sourceIndex++) {
            const rankedSource = diverseSubs
                .filter(s => s.sourceIndex === sourceIndex)
                .sort(compareOpenSubtitlesCandidates);
            sourceBalancedCandidates.push(...rankedSource.slice(0, openSubtitlesLimit));
        }

        // Deduplicare globală după selecția per-sursă. Dacă același URL apare
        // în mai mulți furnizori, păstrăm varianta cu scorul mai bun; la egalitate
        // rămâne prima din ordinea deterministă a surselor.
        const bestCandidateByUrl = new Map();
        for (const candidate of sourceBalancedCandidates) {
            const urlKey = String(candidate.originalUrl);
            const existing = bestCandidateByUrl.get(urlKey);
            if (!existing || candidate.score > existing.score ||
                (candidate.score === existing.score && candidate._rankingOrder < existing._rankingOrder)) {
                bestCandidateByUrl.set(urlKey, candidate);
            }
        }

        diverseSubs = [...bestCandidateByUrl.values()]
            .sort(compareOpenSubtitlesCandidates)
            .slice(0, openSubtitlesLimit);
        

        // ============================================================
        // VIZUALIZARE UI STREMIO (ETICHETE DETALIATE)
        // ============================================================
        const generatedSubdlSubs = subdlCandidates.slice(0, SUBDL_MAX_SUBTITLE_RESULTS).map((s, index) => {
            const scoreTag = s.matchScore === null ? '' : ` • ${Math.round(s.matchScore * 100)}% match`;
            return {
                id: `subdl_ai_sub_${index}`,
                title: `🇷🇴 RO AI · SubDL [${index + 1}]${scoreTag} · ${String(s.realName).replace(/[^\p{L}\p{N} ._\-()[\]]/gu, ' ').slice(0, 100)}`,
                url: `${baseUrl}/${configData}/translate?id=${encodeURIComponent(id)}&subdlRef=${encodeURIComponent(s.nId)}&filename=${encodeURIComponent(String(userFilename || '').slice(0, 500))}&v=subdl-${index + 1}&source=SubDL&subtitleName=${encodeURIComponent(String(s.realName || 'SubDL subtitle').slice(0, 300))}`,
                lang: 'ron'
            };
        });

        const generatedOpenSubtitles = diverseSubs.slice(0, openSubtitlesLimit).map((s, index) => {
            const encodedUrl = encodeURIComponent(s.originalUrl);
            let visualName = String(s.realName || '').replace(/[^a-zA-Z0-9.-]/g, ' ');
            const foundTags = [];
            const resMatch = visualName.match(/\b(2160p|1080p|720p|4k|sd)\b/i);
            if (resMatch) foundTags.push(resMatch[1].toUpperCase());
            const sourceMatch = visualName.match(/\b(bluray|web-dl|webrip|remux|hdtv)\b/i);
            if (sourceMatch) foundTags.push(sourceMatch[1].toUpperCase());
            const extraMatch = visualName.match(/\b(imax|proper|repack|extended|unrated|director'?s cut|hdr10|hdr|dv)\b/ig);
            if (extraMatch) {
                const uniqueExtras = [...new Set(extraMatch.map(t => t.toUpperCase().replace(/\s+/g, ' ')))];
                foundTags.push(...uniqueExtras.slice(0, 3));
            }
            let labelName = subdlCandidates.length ? `🇷🇴 RO AI · OpenSubtitles [${index + 1}]` : `🇷🇴 RO AI [${index + 1}]`;
            if (foundTags.length) labelName += ` • ${foundTags.join(' | ')}`;
            return {
                id: `opensubtitles_ai_sub_${index}`,
                title: labelName,
                url: `${baseUrl}/${configData}/translate?id=${encodeURIComponent(id)}&targetUrl=${encodedUrl}&v=opensubtitles-${index + 1}&source=OpenSubtitles&subtitleName=${encodeURIComponent(String(s.realName || labelName).slice(0, 300))}`,
                lang: 'ron'
            };
        });

        // SubDL păstrează ordinea de ranking nativă; OpenSubtitles rămâne fallback.
        const finalSubtitles = [...generatedSubdlSubs, ...generatedOpenSubtitles]
            .slice(0, subdlCandidates.length ? TOTAL_MAX_SUBTITLE_RESULTS : OPENSUBTITLES_LEGACY_MAX_RESULTS);
        return res.json({ subtitles: finalSubtitles });
    } catch (error) {
        return res.json({ subtitles: [] });
    }
}

async function getSubdlSubtitleText(configId, reference, requestedFilename = '') {
    const isApiReference = reference.startsWith('api_');
    const isDirectUrlRef = reference.startsWith('url_');
    let apiReference = null;
    let directDownloadUrl = '';
    let plainNId = '';

    if (isApiReference) {
        apiReference = decodeSubdlApiReference(reference);
        if (!apiReference) {
            const error = new Error('Referință SubDL API invalidă.');
            error.statusCode = 400;
            throw error;
        }
        directDownloadUrl = apiReference.directUrl;
        plainNId = apiReference.nId;
    } else if (isDirectUrlRef) {
        if (!/^url_[A-Za-z0-9_-]{8,2048}$/.test(reference)) {
            const error = new Error('Referință SubDL invalidă.');
            error.statusCode = 400;
            throw error;
        }
        try { directDownloadUrl = subdlDirectDownloadUrl(Buffer.from(reference.slice(4), 'base64url').toString('utf8')); }
        catch (_) { directDownloadUrl = ''; }
        if (!directDownloadUrl) {
            const error = new Error('URL SubDL nepermis.');
            error.statusCode = 400;
            throw error;
        }
    } else {
        plainNId = reference;
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(plainNId)) {
            const error = new Error('Identificator SubDL invalid.');
            error.statusCode = 400;
            throw error;
        }
    }

    // An unpacked API result may identify a single member of a pack. Use that
    // documented direct-file URL so we don't accidentally translate the parent archive.
    if (isApiReference && apiReference?.fileNId) {
        const sourceIds = subdlIdsFromDirectUrl(directDownloadUrl);
        const directIsExact = sourceIds?.pattern === 'path-pair' &&
            sourceIds.nId === apiReference.nId && sourceIds.fileNId === apiReference.fileNId;
        if (!directIsExact) {
            const exact = new URL(`https://dl.subdl.com/subtitle/${encodeURIComponent(apiReference.nId)}/${encodeURIComponent(apiReference.fileNId)}`);
            // Preserve provider-issued signed parameters while stripping API-key credentials.
            try {
                const supplied = new URL(directDownloadUrl);
                for (const [key, value] of supplied.searchParams.entries()) {
                    if (!['api_key', 'x-api-key'].includes(key.toLowerCase()) && !exact.searchParams.has(key)) {
                        exact.searchParams.append(key, value);
                    }
                }
            } catch (_) {}
            const exactFileUrl = subdlDirectDownloadUrl(exact.toString());
            if (exactFileUrl) directDownloadUrl = exactFileUrl;
        }
    }

    const addonConfig = decodeAddonConfigSegment(configId);
    if (!addonConfig?.subdlKey) {
        const error = new Error('SubDL nu este configurat pentru această instalare.');
        error.statusCode = 404;
        throw error;
    }

    let response = null;
    let bytes;
    try {
        if (isDirectUrlRef) {
            bytes = await fetchSubdlDirectWithFallback(directDownloadUrl, addonConfig.subdlKey);
        } else {
            // When file_n_id is known, first fetch that exact file from SubDL's documented
            // /subtitle/{n_id}/{file_n_id} route; the parent nId endpoint can otherwise select
            // a different member of a multi-file pack.
            let exactFileAttempted = false;
            let exactFileError = null;
            if (isApiReference && apiReference?.fileNId && directDownloadUrl) {
                exactFileAttempted = true;
                try {
                    bytes = await fetchSubdlDirectWithFallback(directDownloadUrl, addonConfig.subdlKey);
                } catch (error) {
                    exactFileError = error;
                    console.log(`[SubDL] Descărcarea fișierului exact a eșuat (${error.response?.status || error.subdlDownloadMeta?.status || 'rețea'}); încerc API v2 ca rezervă.`);
                }
            }

            // API v2 download contract: /subtitles/{nId}/download?format=file.
            const makeApiUrl = () => {
                const url = new URL(`https://api.subdl.com/api/v2/subtitles/${encodeURIComponent(plainNId)}/download`);
                url.searchParams.set('format', 'file');
                return url.toString();
            };
            const requestApi = () => axios.get(makeApiUrl(), {
                headers: { Authorization: `Bearer ${addonConfig.subdlKey}`, 'User-Agent': BROWSER_USER_AGENT_FETCH },
                timeout: 25000,
                maxContentLength: 25 * 1024 * 1024,
                maxBodyLength: 25 * 1024 * 1024,
                responseType: 'arraybuffer',
                maxRedirects: 0,
                validateStatus: status => status >= 200 && status < 400
            });

            if (!bytes) {
                try {
                    response = await requestApi();
                } catch (apiError) {
                    const apiStatus = Number(apiError?.response?.status || 0);
                    if (!exactFileAttempted && directDownloadUrl && [400, 401, 403, 404, 409, 422].includes(apiStatus)) {
                        console.log(`[SubDL] Descărcarea oficială API v2 a eșuat (${apiStatus}); încerc URL-ul direct original, păstrat ca fallback.`);
                        bytes = await fetchSubdlDirectWithFallback(directDownloadUrl, addonConfig.subdlKey);
                    } else if (exactFileError) {
                        throw exactFileError;
                    } else {
                        throw apiError;
                    }
                }
            }

            if (response) {
                const redirectLocation = response.status >= 300 ? response.headers?.location : '';
                if (redirectLocation) {
                    // Do not forward the API bearer token across hosts.
                    const redirectUrl = new URL(redirectLocation, makeApiUrl()).toString();
                    bytes = await fetchSubdlDirectWithFallback(redirectUrl, addonConfig.subdlKey);
                    response = { headers: { 'content-type': 'application/x-subrip' }, status: 200 };
                } else {
                    bytes = Buffer.from(response.data || []);
                }
            }
        }

        if (!bytes?.length) throw new Error('SubDL a returnat un fișier gol.');
        const contentType = String(response?.headers?.['content-type'] || '').toLowerCase();

        // Resolve download URLs only against SubDL's download host and validate the
        // resulting public destination before making any outbound request.
        if (contentType.includes('application/json') || bytes.toString('utf8', 0, Math.min(bytes.length, 20)).trimStart().startsWith('{')) {
            let parsed = null;
            try { parsed = JSON.parse(bytes.toString('utf8')); } catch (_) {}
            const rawDirectUrl = String(parsed?.url || parsed?.download_url || parsed?.downloadUrl || parsed?.file?.url || '').trim();
            const resolvedDirectUrl = rawDirectUrl ? new URL(rawDirectUrl, 'https://dl.subdl.com').toString() : '';
            const safeResolvedUrl = subdlDirectDownloadUrl(resolvedDirectUrl);
            if (safeResolvedUrl) {
                bytes = await fetchSubdlDirectWithFallback(safeResolvedUrl, addonConfig.subdlKey);
            } else if (directDownloadUrl && !(isApiReference && apiReference?.fileNId && exactFileError)) {
                console.log('[SubDL] API v2 a răspuns JSON fără URL descărcabil; încerc URL-ul original al rezultatului.');
                bytes = await fetchSubdlDirectWithFallback(directDownloadUrl, addonConfig.subdlKey);
            } else if (exactFileError) {
                throw exactFileError;
            } else {
                throw new Error('SubDL nu a returnat o subtitrare descărcabilă.');
            }
        }

        return normalizeDownloadedSubtitle(
            bytes,
            directDownloadUrl || `https://api.subdl.com/api/v2/subtitles/${encodeURIComponent(plainNId)}/download`,
            String(requestedFilename || '').slice(0, 500)
        );
    } catch (error) {
        const status = Number(error?.response?.status || error?.subdlDownloadMeta?.status || 0);
        console.log(`[SubDL] Descărcare nereușită (${isApiReference ? 'ID derivat din URL' : isDirectUrlRef ? 'URL direct' : 'nId'}; ${status || 'eroare de rețea'}); nu se expune cheia.`);
        error.statusCode = error.statusCode || 502;
        throw error;
    }
}

app.get('/:configData/subdl-file/:nId', async (req, res) => {
    try {
        const normalized = await getSubdlSubtitleText(req.params.configData, String(req.params.nId || ''), req.query.filename);
        res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
        res.setHeader('Cache-Control', 'private, max-age=60');
        return res.send(normalized);
    } catch (error) {
        const statusCode = Number(error?.statusCode || 502);
        const publicMessage = statusCode === 400 || statusCode === 404
            ? error.message
            : 'SubDL nu a putut furniza această subtitrare.';
        return res.status(statusCode).send(publicMessage);
    }
});

app.get('/:configData/subtitles/:type/:id.json', handleSubtitles);
app.get('/:configData/subtitles/:type/:id/:extra.json', handleSubtitles);

// ============================================================
// EMPTY SOURCE BLOCK PROTECTION
// Ignoră blocurile care conțin doar spații sau caractere invizibile
// (zero-width/BOM/formatting/mark-uri Unicode). Acestea nu reprezintă
// replici reale și nu trebuie să ajungă în pipeline-ul Gemini.
// ============================================================

function isEffectivelyEmptySubtitleText(text) {
    // Considerăm gol orice text format doar din whitespace, caractere de control/format,
    // semne Unicode invizibile SAU entități HTML care reprezintă astfel de caractere.
    // Verificarea este folosită doar pentru DETECTAREA GOLULUI; nu modifică textul real.
    let clean = String(text || '')
        .replace(/<[^>]+>/g, '');

    // Unele SRT-uri encodează spațiile/caracterele invizibile ca entități HTML.
    // Le decodăm doar în scopul detectării golului.
    clean = clean.replace(/&#x([0-9a-f]+);?/gi, (_, hex) => {
        const codePoint = Number.parseInt(hex, 16);
        return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10FFFF
            ? String.fromCodePoint(codePoint)
            : '';
    });

    clean = clean.replace(/&#(\d+);?/g, (_, decimal) => {
        const codePoint = Number.parseInt(decimal, 10);
        return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10FFFF
            ? String.fromCodePoint(codePoint)
            : '';
    });

    clean = clean
        .replace(/&(?:nbsp);?/gi, ' ')
        .replace(/&(?:zwsp|zwnj|zwj|lrm|rlm|shy|feff);?/gi, '')
        .replace(/[\p{C}\p{M}\s]/gu, '')
        .trim();

    return clean === '';
}

// ============================================================
// STANDALONE INTERJECTIONS / FILLERS
// ============================================================

const STANDALONE_SOURCE_FILLERS = new Set((
    // Aceste vocalizări nu sunt păstrate ca traduceri autonome.
    // Nu ștergem „Oh/Ah” din expresii dialogate valide; filtrăm doar liniile formate
    // exclusiv din interjecții. „Hmm”, „Mhm” și „Mm-hmm” rămân evaluate contextual.
    'aaaa aaaaah aaaah aaah ah oh ehm er erm err errr ha hahaha heh hehe mwah uh uhh uhhh uhm uhmm um umm uu ă ăă ăăă ptiu'
).split(/\s+/));

// Elimină „oh/ah” numai când linia conține exclusiv interjecții și punctuație.
// Expresii dialogate precum „Oh, no!”, „Ah, yes!” și „Oh my God” rămân intacte.
// Marcajele HTML sunt ignorate doar pentru clasificarea unei linii de interjecție izolată.
function stripLeadingOhAhInterjections(value) {
    return String(value || '').split('\n').map(line => {
        const visibleLine = line.replace(/<[^>]*>/g, '').trim();
        if (!visibleLine) return line;
        if (/^(?:[-–—]\s*)?(?:(?:oh|ah)\b[\s,;:!?.…–—-]*)+$/iu.test(visibleLine)) return '';
        return line;
    }).join('\n');
}

function isOnlyStandaloneFillerSequence(text) {
    const clean = String(text || '').replace(/<[^>]*>/g, ' ').trim();
    if (!clean) return false;
    const normalized = clean
        .replace(/^[-–—\s]+/, '')
        .toLocaleLowerCase('ro-RO')
        .replace(/[.,!?;:…]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!normalized) return false;
    const tokens = normalized.split(' ').filter(Boolean);
    return tokens.length > 0 && tokens.every(token => STANDALONE_SOURCE_FILLERS.has(token));
}

// ============================================================
// FILTRARE TEXT DELIMITAT ȘI DESCRIERI NON-DIALOGATE
// Elimină orice segment dintre paranteze rotunde (...) sau drepte [...] înainte de Gemini
// și din traducerea finală, indiferent de conținut. Textul din afara delimitatorilor rămâne.
// Cue-urile sonore scrise fără paranteze sunt filtrate separat, contextual.
// ============================================================

const SOUND_CUE_ACTION_RE = /(?<![\p{L}\p{N}])(?:babbl(?:e|es|ed|ing)|coo(?:s|ed|ing)?|gurgle(?:s|d|ing)?|knock(?:s|ed|ing)?|bang(?:s|ed|ing)?|pound(?:s|ed|ing)?|thud(?:s|ded|ding)?|thump(?:s|ed|ing)?|ring(?:s|ing)?|beep(?:s|ed|ing)?|buzz(?:es|ed|ing)?|click(?:s|ed|ing)?|clatter(?:s|ed|ing)?|clang(?:s|ed|ing)?|crash(?:es|ed|ing)?|slam(?:s|med|ming)?|creak(?:s|ed|ing)?|cough(?:s|ed|ing)?|clear(?:s|ed|ing)\s+(?:(?:his|her|their|its|my|your)\s+)?throat|throat\s+clearing|sigh(?:s|ed|ing)?|gasp(?:s|ed|ing)?|groan(?:s|ed|ing)?|grunt(?:s|ed|ing)?|snort(?:s|ed|ing)?|sniff(?:s|ed|ing|les|led)?|sneez(?:e|es|ed|ing)|laugh(?:s|ed|ing)?|chuckl(?:e|es|ed|ing)|giggl(?:e|es|ed|ing)|sob(?:s|bed|bing)?|cri(?:es|ed|ying)|scream(?:s|ed|ing)?|yelp(?:s|ed|ing)?|wail(?:s|ed|ing)?|moan(?:s|ed|ing)?|roar(?:s|ed|ing)?|exhale(?:s|d|ing)?|shout(?:s|ed|ing)?|whisper(?:s|ed|ing)?|pant(?:s|ed|ing)?|snor(?:es|ed|ing)|whimper(?:s|ed|ing)?|growl(?:s|ed|ing)?|bark(?:s|ed|ing)?|meow(?:s|ed|ing)?|chirp(?:s|ed|ing)?|howl(?:s|ed|ing)?|rustl(?:e|es|ed|ing)|rattl(?:e|es|ed|ing)|rumbl(?:e|es|ed|ing)|whistl(?:e|es|ed|ing)|clap(?:s|ped|ping)?|applaud(?:s|ed|ing)?|sing(?:s|ing)?|hum(?:s|med|ming)|footsteps?\s+(?:approach|recede|stop|fade|pass)|heavy\s+breathing|breathing\s+heavily|soft\s+breathing|squeak(?:s|ed|ing)?|squeal(?:s|ed|ing)?|scrap(?:e|es|ed|ing)|scratch(?:es|ed|ing)|shuffle(?:s|d|ing)|swallow(?:s|ed|ing)?|gulp(?:s|ed|ing)?|wind\s+howl(?:s|ing)?|birds?\s+chirp(?:s|ing)?|doorbell\s+ring(?:s|ing)?|phone\s+ring(?:s|ing)?|music\s+play(?:s|ing)?|background\s+music|gângur(?:ește|ind|it)|băt(?:aie|ăi|e|ește|ând|ut)|ciocăn(?:it|ește|ind|ituri)?|pocnet(?:e|ul)?|pocnește|bubuit(?:uri)?|bubuie|zgomot(?:e)?|sunet(?:e)?\s+de|sonerie|bip(?:uri|uie)?|țiuit|trosnet(?:e)?|trosnește|trântește|trântit|scârțâi(?:t|ește|ind)|pași|foșnet|foșnește|fâșâit|tușește|tușind|tușit|își\s+drege\s+glasul|dreg(?:e|ându-și)\s+glasul|gâfâie|gâfâind|gâfâit|respiră\s+greu|respirație\s+grea|oftează|oftând|oftat|suspin(?:ă|ând)?|mormăit|mormăie|mormăind|bufnește|bufnet|râde|râzând|râs|chicotește|chicotind|plânge|plângând|plâns|țipă|țipăt|țipând|strigă|strigând|horcăie|sforăie|adulmecă|fornăie|sughiță|șuieră|fluieră|fredonează|face\s+fâ+|cântă\s+încet|bate\s+din\s+palme|aplauze|urale|clopoțel|răpăit|zdrăngănit|vibrează|hârâit|bufnire|bufniri|bufnete|bufnituri|șuierături|fluierături|pufnire|pufniri|râsete|plânsete|gemete|geamăt(?:e)?|suspin(?:e|uri)?|sughițuri|foșnet(?:e|uri)?|fâșâit(?:uri)?)(?![\p{L}\p{N}])/iu;

// Extensie îngustă pentru etichete SDH frecvente care nu erau acoperite de lista de bază.
// Sunt expresii închise/descrieri de sunet; nu se aplică în interiorul replicilor obișnuite.
const SOUND_CUE_EXTENDED_LABEL_PATTERNS = [
    /^(?:crowd\s+)?clamor(?:s|ed|ing)?[.!…]*$/iu,
    /^(?:yell(?:s|ed|ing)?|cheer(?:s|ed|ing)?|(?:crowd\s+)?cheering)[.!…]*$/iu,
    /^(?:stammer(?:s|ed|ing)?|mutter(?:s|ed|ing)?|scoff(?:s|ed|ing)?|snarl(?:s|ed|ing)?|shriek(?:s|ed|ing)?|mouthing|straining)[.!…]*$/iu,
    /^(?:pained\s+shrieking|shrieking\s+stops|soft\s*,?\s*clicking\s+vocalizations?|(?:bullets?|projectiles?)\s+ricochet(?:s|ed|ing)?|[\p{Lu}][\p{L}'’-]+\s+(?:stammers?|straining))[.!…]*$/u,
    /^(?:shuddering|trembling)\s+breaths?(?:\s+continue)?[.!…]*$/iu,
    /^(?:[\p{L}][\p{L}'’-]*['’]s\s+)?breath(?:s)?\s+(?:continues?\s+)?(?:trembling|stops?\s+trembling)[.!…]*$/iu,
    /^(?:(?:takes?|taking|both taking)\s+)?deep\s+breaths?[.!…]*$/iu,
    /^(?:(?:(?:heavy|deep|shallow|trembling|shuddering|rapid|ragged|labou?red|wheezy|shaky|gruff|sharp|gasping|long|slow|soft|quiet|loud)(?:\s*,\s*|\s+)){1,3})(?:breaths?|breathing)(?:\s+(?:continues?|nearby|deeply|calms\s+down|trembling|heavily|softly))?[.!…]*$/iu,
    /^(?:(?:a|an|the|some|soft|loud|quiet|distant|faint|heavy|rapid|sharp|muffled|electronic|electrical|power|device|piano|metallic|softly)\s+){0,4}(?:whirr(?:s|ed|ing)?|whoosh(?:es|ed|ing)?|crackl(?:e|es|ed|ing)|warbl(?:e|es|ed|ing)|thrumm?(?:s|ed|ing)?|sizzl(?:e|es|ed|ing)|clack(?:s|ed|ing)?|clink(?:s|ed|ing)?|flutter(?:s|ed|ing)?|jingl(?:e|es|ed|ing)|ding(?:s|ed|ing)?|resonat(?:e|es|ed|ing)|boom(?:s|ed|ing)|ricochet(?:s|ed|ing)?|tear(?:s|ed|ing)|shatter(?:s|ed|ing)|snarl(?:s|ed|ing)|scoff(?:s|ed|ing))[.!…]*$/iu,
    /^(?:(?:backpack\s+drops?\s+to\s+(?:the\s+)?ground)|(?:snips?\s+(?:the\s+)?zip\s+tie)|(?:dialing\s+(?:the\s+)?phone)|(?:elevator\s+bell\s+chimes?)|(?:(?:entry|crossing|elevator)\s+bell\s+(?:jingling|dinging|chimes?))|(?:bell\s+(?:jingling|dinging|rings?))|(?:music\s+(?:ends|shuts\s+off))|(?:door\s+opens?\s+and\s+closes?)|(?:(?:vehicle|car)\s+door\s+(?:opens?|closes?))|(?:door\s+opens?)|(?:rapid\s+footsteps?)|(?:footsteps?\s+approaching)|(?:truck\s+departing)|(?:vehicles?\s+approaching)|(?:snaps?\s+fingers)|(?:taps?\s+(?:the\s+)?key)|(?:gunfire|gun\s+fires?)|(?:shower\s+water\s+running)|(?:air\s+pumping)|(?:glass\s+shards\s+clinking)|(?:voice\s+breaking)|(?:soft\s+clicking\s+vocalizations?)|(?:makes\s+whooshing\s+sound)|(?:piano\s+strings\s+resonating)|(?:piano\s+strings\s+thrumming)|(?:device\s+thrumming)|(?:device\s+sizzling)|(?:wings\s+fluttering)|(?:hailstones\s+clacking)|(?:conversing\s+in\s+Korean)|(?:praying\s+in\s+Latin)|(?:Park\s+continues\s+in\s+Korean)|(?:hisses\s+in\s+pain)|(?:Daniel\s+inhales\s+deeply)|(?:inhales?\s+deeply)|(?:breathing\s+calms\s+down)|(?:breathing\s+deeply)|(?:deep\s+breathing)|(?:muffled\s+shattering)|(?:glass\s+shattering)|(?:explosion\s+booming))[.!…]*$/iu,
    /^(?:soft\s+electrical\s+warbling|soft\s+electrical\s+whooshing|soft\s+electrical\s+crackling|soft\s+whooshing\s*,\s*crackling|sharp\s+whoosh|soft\s+whirring|power\s+whirring|jet\s+engine\s+whirring|long\s*,\s*slow\s+gasp|rapid\s*,\s*gasping\s+breaths?|heavy\s*,\s*gasping\s+breaths?|heavy\s*,\s*labored\s+breathing|heavy\s*,\s*shaky\s+breathing|sharp\s*,\s*heavy\s+breathing|gruff\s*,\s*heavy\s+breathing\s+nearby|deep\s*,\s*wheezy\s+breathing|whimpering\s*,\s*straining|distressed\s+shrieking\s*,\s*clicking)[.!…]*$/iu,
    // Captions vocale autonome cu subiect (JOHN MUMBLES, HE BREATHES DEEPLY etc.).
    // Acest pattern suplimentar este intenționat limitat la text scris integral cu majuscule.
    /^(?:HE|SHE|THEY|SOMEONE|MAN|WOMAN|[A-Z][A-Z'’.-]*(?:\s+[A-Z][A-Z'’.-]*){0,2})\s+(?:INHALES?|EXHALES?|BREATHES?(?:\s+(?:DEEPLY|DEEP|HEAVILY|UNEVENLY|SOFTLY|SHALLOWLY|RAGGEDLY|RAPIDLY|SHARPLY))?|MUMBLES?|MUTTERS?(?:\s+TO\s+(?:HIMSELF|HERSELF|THEMSELVES))?|STAMMERS?|SIGHS?|GASPS?|GROANS?|GRUNTS?|SOBS?(?:\s+(?:LOUDLY|SOFTLY|QUIETLY))?|CHUCKLES?|CHIRPS?(?:\s+NONSENSE)?|CLEARS?\s+(?:HIS\s+|HER\s+|THEIR\s+)?THROAT|COUGHS?|LAUGHS?|CRIES?|WHIMPERS?|SNIFFS?|SPLUTTERS?|REVS?)(?:\s+(?:SOFTLY|QUIETLY|LOUDLY|DEEPLY|HEAVILY|GENTLY|UNEVENLY|SHALLOWLY|RAGGEDLY|RAPIDLY|SHARPLY|ANXIOUSLY|CAUTIOUSLY))?[.!…]*$/u
];

function isExtendedSoundCueLabel(text) {
    return SOUND_CUE_EXTENDED_LABEL_PATTERNS.some(pattern => pattern.test(text));
}


// Clasificator structural pentru caption-uri SDH scrise în stil editorial (de regulă cu majuscule).
// În loc să enumerăm fiecare expresie completă („KEYS JANGLE”, „CAR HORN TOOTS” etc.),
// recunoaștem forma tipică: etichetă scurtă, fără punctuație de dialog, cu verb de eveniment
// sonor sau substantiv acustic. Este intenționat conservator: textul ambiguu rămâne la traducere.
const SOUND_CUE_STRUCTURAL_ACTION_RE = /\b(?:jangle(?:s|d|ing)?|crunch(?:es|ed|ing)?|toot(?:s|ed|ing)?|rev(?:s|ved|ving)?|stall(?:s|ed|ing)?|grind(?:s|ed|ing)?|squeal(?:s|ed|ing)?|screech(?:es|ed|ing)?|blare(?:s|d|ing)?|jam(?:s|med|ming)?|ping(?:s|ed|ing)?|clink(?:s|ed|ing)?|whine(?:s|d|ing)?|shatter(?:s|ed|ing)?|murmur(?:s|ed|ing)?|slurp(?:s|ed|ing)?|snicker(?:s|ed|ing)?|erupt(?:s|ed|ing)?|crackle(?:s|d|ing)?|sizzle(?:s|d|ing)?|hiss(?:es|ed|ing)?|drone(?:s|d|ing)?|splash(?:es|ed|ing)?|argu(?:e|es|ed|ing)|turns?\s+over|cuts?\s+(?:out|off)|go(?:es)?\s+off|falls?\s+silent|reverberat(?:e|es|ed|ing)|amplif(?:y|ies|ied|ying)|shuts?(?:\s+off)?|opens?(?:\s+and\s+closes?)?)\b/iu;
const SOUND_CUE_STRUCTURAL_NOUN_RE = /\b(?:tone|chatter|hubbub|commentary|comms|applause|footsteps?|music|silence|static|ringing|beeping|buzzing|whistle|whistling|crunching|squeaking|creaking|crying|laughter|breathing|sound|noise|siren|fireworks?)\b/iu;
const SOUND_CUE_STRUCTURAL_SOURCE_RE = /\b(?:keys?|lock|radio|program(?:me)?|biscuit|car|horn|phone|sms|engine|gearbox|tyres?|tires?|whiteboard|door|office|metal|seat\s+belt|glass|sports?\s+commentary)\b/iu;

function isGenericUppercaseSoundCaption(text, words) {
    if (!text || words.length < 2 || words.length > 8) return false;
    const letters = text.match(/\p{L}/gu) || [];
    if (letters.length < 3 || text !== text.toLocaleUpperCase('en-US')) return false;

    // Întrebările, citatele, formulele de conversație și construcțiile gramaticale complete
    // nu sunt eliminate de fallback-ul structural, chiar dacă menționează râs/respirație etc.
    if (/[?"“”]/u.test(text)) return false;
    if (/\b(?:I|ME|MY|MINE|YOU|YOUR|YOURS|WE|US|OUR|OURS|HE|SHE|THEY|IT|PLEASE|YES|NO|OK|OKAY|WHAT|WHY|HOW|WHERE|WHEN|WHO|HELP|STOP|WAIT|GET|COME|LET|DON'T|CANNOT|CAN'T|WON'T|WOULD|SHOULD|COULD|MUST|AM|ARE|IS|WAS|WERE|HAVE|HAS|HAD|DO|DOES|DID|NOT|ALWAYS|NEVER|EVERYONE|EVERYBODY|NOBODY|SOMEBODY|SOMETHING|ANYTHING|ABOUT|BECAUSE|WHENEVER|WHILE|ALTHOUGH|THAT|THIS|THESE|THOSE|AT|WITH|FROM|FOR|AFTER|BEFORE)\b/u.test(text)) return false;
    if (/[;,:]/u.test(text)) return false;

    // Este fallback se aplică doar dacă există și un indiciu semantic acustic.
    // Astfel, majusculele singure nu sunt suficiente pentru a șterge dialogul.
    const hasSoundVerb = SOUND_CUE_STRUCTURAL_ACTION_RE.test(text) || SOUND_CUE_ACTION_RE.test(text);
    const hasAcousticNoun = SOUND_CUE_STRUCTURAL_NOUN_RE.test(text);
    const hasSoundSource = SOUND_CUE_STRUCTURAL_SOURCE_RE.test(text);
    const hasMediaPlayback = /\b(?:radio|program(?:me)?|commentary|music|song|recording|broadcast)\b.*\bplays?\b/iu.test(text);
    const hasSourceEvent = hasSoundSource && /\b(?:cuts?|idles?|turns?\s+over|shuts?(?:\s+off)?|opens?(?:\s+and\s+closes?)?)\b/iu.test(text);
    return hasAcousticNoun || hasSoundVerb || (hasSoundSource && hasMediaPlayback) || hasSourceEvent;
}

const SOUND_CUE_LABEL_RE = /^(?:(?:a|an|the|some|soft|loud|quiet|distant|faint|background|gentle|heavy|slight|small|short|brief|off-screen|în fundal|încet|încetișor|tare|ușor|scurt|scurtă|puternic|puternică|îndepărtat(?:ă|e)?|slab(?:ă|e)?)\s+)*(?:sound(?:s)?(?:\s+of)?|noise(?:s)?(?:\s+of)?|music(?:\s+(?:playing|continues|swells|fades|starts|stops|in background))?|applause|laughter|laugh(?:s|ing)?|footsteps?|knocking|banging|pounding|thudding|thumping|doorbell|ringing|beeping|buzzing|clicking|clattering|crashing|slamming|creaking|cough(?:ing|s)?|sigh(?:ing|s)?|gasp(?:ing|s)?|groan(?:ing|s)?|grunt(?:ing|s)?|snoring|heavy breathing|breathing heavily|breathing|whispering|singing|humming|babbling|murmuring|whimpering|growling|snorting|sniffing|sneezing|screaming|shouting|panting|chirping|howling|rustling|rattling|rumbling|whistling|clapping|shuffling|swallowing|gulping|squeaking|squealing|scraping|scratching|wind howling|birds? chirping|doorbell ringing|phone ringing|background music|bătaie(?:\s+în\s+ușă)?|bătăi(?:\s+în\s+ușă)?|gângurit(?:ul)?|mormăit(?:ul|uri)?|suspin(?:ând|e|uri)?|oftat(?:ul)?|râs(?:ul)?|râde|râzând|râsete|plâns(?:ul)?|plânge|plângând|plânsete|pași|aplauze|urale|tușit(?:ul)?|tușește|tușind|gâfâit(?:ul|uri)?|gâfâie|gâfâind|bufnet(?:ul|e)?|bufnește|bufnire|bufniri|pufnet(?:ul|e)?|pufnește|pufnire|foșnet(?:ul|e|uri)?|foșnește|fâșâit(?:ul|uri)?|fâșâie|trosnet(?:ul|e)?|trosnește|zgomot(?:e)?(?:\s+de\s+[^.!?]{1,60})?|sunet(?:e)?(?:\s+de\s+[^.!?]{1,60})?|șuieră|șuierând|șuierături|fluieră|fluierând|fluierături|geme|gemând|geamăt(?:e)?|gemete|horcăie|horcăit(?:ul|uri)?|sforăie|sforăit|adulmecă|fornăie|sughiță|sughițuri|fredonează|cântă\s+încet|face\s+fâ+|bate\s+din\s+palme|clopoțel|răpăit|zdrăngănit|vibrează|hârâit)(?:\s+(?:in the background|from outside|from inside|în fundal|se aude|continuă|încet|tare|ușor|puternic|loudly|softly))?[.!…]*$/iu;

function stripBracketedSegments(text) {
    let removedCount = 0;
    let clean = String(text || '');

    // Regula cerută: nimic din interiorul parantezelor rotunde sau drepte
    // nu ajunge în subtitrarea finală. Repetăm pentru a acoperi și delimitări imbricate.
    const bracketedSegmentPattern = /\([^()\[\]]*\)|\[[^()\[\]]*\]|\([^()\[\]\r\n]{1,80}\]|\[[^()\[\]\r\n]{1,80}\)/g;
    let previous;
    do {
        previous = clean;
        clean = clean.replace(bracketedSegmentPattern, () => {
            removedCount++;
            return ' ';
        });
    } while (clean !== previous);

    // Reparăm punctuația și spațiile rămase după eliminarea segmentelor delimitate.
    clean = clean
        .replace(/^([ \t]*)[:,;][ \t]*/gm, '$1')
        .replace(/[ \t]+([,;:!?])/g, '$1')
        .replace(/[,;:][ \t]*([.!?])/g, '$1')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n[ \t]*\n+/g, '\n');
    if (removedCount && /^[ \t\r\n\-–—,;:.!?…]+$/.test(clean)) clean = '';

    return { text: clean, removedCount };
}

// Detectează și etichetele sonore care apar singure, fără paranteze: „Whistling”,
// „râsete”, „bufnire” etc. Este un test de linie întreagă, ca să nu șteargă dialog
// precum „Râde de mine” sau propoziții care doar menționează un sunet.
function isStandaloneNonDialogueSoundCue(value) {
    const text = String(value || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/[♪♫♬♩]+/g, ' ')
        .replace(/^[\s\-–—]+|[\s\-–—]+$/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!text || text.length > 180) return false;

    // „Cheers.” este frecvent o replică de dialog (de ex. salut/încheiere),
    // nu o descriere de public care aplaudă. O păstrăm ca text dialogat.
    if (/^cheers[.!…]*$/iu.test(text)) return false;

    // Etichetele explicite deja recunoscute rămân tratamentul cu cea mai mare încredere.
    if (SOUND_CUE_LABEL_RE.test(text) || isExtendedSoundCueLabel(text)) return true;

    // Regula generală pentru caption-uri SDH: folosește structura, stilul editorial și
    // semantica acustică, nu o listă de expresii complete specifice unui singur film.
    const words = text.match(/[\p{L}\p{N}]+/gu) || [];
    if (isGenericUppercaseSoundCaption(text, words)) return true;

    // Nu interpretăm ca efect sonor propoziții din perspectiva vorbitorului sau adresate interlocutorului.
    // Exemple păstrate: "I laugh when I'm nervous", "You gasp every time", "We scream about it".
    if (/^(?:i|you|we|they)\b/iu.test(text)) return false;
    if (/[;:?,'"“”]/u.test(text)) return false;

    // Unele piste scriu cue-ul fără paranteze și numai la forma verbală:
    // "Screams", "Yelps", "Man gasps". Acceptăm forme foarte scurte, nu fraze explicative.
    if (words.length <= 2 && SOUND_CUE_ACTION_RE.test(text)) return true;

    // Acceptăm descriptori de tip closed caption (subiect nominal + acțiune sonoră),
    // dar nu propoziții mai lungi de dialog precum "She laughs at me after work".
    const captionSubject = text.match(/^(?:(?:a|an|the|another|some|distant|off-screen)\s+)?(?:man|woman|person|someone|somebody|child|baby|girl|boy|crowd|people|audience|group|dog|cat|bird|birds|men|women|kids|children|voice|voices|animal|animals)\s+(?:(?:is|are)\s+)?(.+?)[.!…]*$/iu);
    if (captionSubject && words.length <= 7 && SOUND_CUE_ACTION_RE.test(captionSubject[1])) return true;

    return false;
}

// Filtrare aplicată atât sursei, cât și traducerii finale:
// elimină integral segmentele dintre (...) și [...] indiferent de conținut,
// păstrează textul din afara lor și filtrează separat cue-urile sonore izolate.
function stripNonDialogueSoundMarkup(value) {
    let clean = String(value || '');
    let removedCount = 0;

    const bracketed = stripBracketedSegments(clean);
    clean = bracketed.text;
    removedCount += bracketed.removedCount;


    // Înlăturăm cue-urile sonore simple rămase pe linii proprii.
    clean = clean.split('\n').map(line => {
        if (!isStandaloneNonDialogueSoundCue(line)) return line;
        removedCount++;
        return '';
    }).join('\n');

    // Eliminăm marcatorii de vorbitor orfani când singurul conținut de după ei era un sunet.
    clean = clean
        .replace(/^[ \t]*[-–—][ \t]*$/gm, '')
        .replace(/[ \t]+[-–—][ \t]*$/gm, '')
        .replace(/^([ \t]*)[:,;][ \t]*/gm, '$1')
        .replace(/[ \t]+([,;:!?])/g, '$1')
        .replace(/[,;:][ \t]*([.!?])/g, '$1')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n[ \t]*\n+/g, '\n')
        .trim();

    // Și un cue complet rămas pe un singur rând este eliminat, fără a șterge propoziții.
    if (isStandaloneNonDialogueSoundCue(clean)) {
        clean = '';
        removedCount++;
    }

    // Dacă din „- [sighs] / - Replica” a rămas un singur vorbitor, liniuța de dialog nu mai are rost.
    if (removedCount && clean && !clean.includes('\n')) {
        clean = clean.replace(/^[ \t]*[-–—][ \t]+(?=\S)/, '');
    }
    if (removedCount && /^[ \t\r\n\-–—,;:.!?…]+$/.test(clean)) clean = '';

    return { text: clean, removedCount };
}

// ============================================================
// CLEAN TEXT FOR JSON 
// ============================================================

function cleanTextForJson(text) {
    if (!text) return text;
    let clean = text;

    clean = clean.replace(/\{[^}]+\}/g, '');
    clean = clean.replace(/[♪♫♬♩#]/gi, '');
    clean = clean.replace(/â™ª/gi, '');
    clean = clean.replace(/â™«/gi, '');

    clean = clean.replace(/<[iIbBuU]>\s*(?:uh|uhh|uhhh|uhm|uhmm|um|umm|ehm|erm|err|mwah|ă|ăă|ăăă|uu)[!.,?\s-]*\s*<\/[iIbBuU]>/gi, '');
    clean = clean.replace(/<[iIbBuU]>\s*<\/[iIbBuU]>/gi, '');

    // Segmentele dintre (...) și [...] sunt eliminate înainte de formarea calupurilor
    // prin stripNonDialogueSoundMarkup(), iar rezultatul final trece din nou prin același filtru.

    // SubStudio curăță etichetele de vorbitor cu majuscule înainte de traducere.
    // Aplicăm aceeași idee strict la începutul unei linii și numai înainte de două puncte.
    clean = clean.replace(/(^|\n)(\s*[-–—]?\s*)[A-ZÀ-Ü][A-ZÀ-Ü0-9. \t]{1,27}:\s*/g, '$1$2');

    // Eliminăm înainte de Gemini doar liniile formate exclusiv din interjecții Oh/Ah.
    // Cuvintele și nuanța expresiilor dialogate sunt păstrate.
    clean = stripLeadingOhAhInterjections(clean);

    // Normalize spacing left behind after removed sound labels.
    clean = clean.replace(/[ \t]{2,}/g, ' ');

    // Eliminăm replicile alcătuite exclusiv din interjecții, inclusiv secvențe
    // precum „Um... hmm.”. Expresiile cu sens, de ex. „Oh my God”, rămân.
    let lines = clean.split('\n').map(l => l.trim()).filter(Boolean).filter(line => {
        return !isOnlyStandaloneFillerSequence(line);
    });
    clean = lines.join('\n');

    if (!clean.trim()) return ' ';
    return clean.trim();
}

// ============================================================
// FORMAT LINE & DICTIONARY
// ============================================================

function deepCleanSubtitleText(text) {
    if (!text) return text;

    // Plasă de siguranță doar pentru replici formate exclusiv din interjecții Oh/Ah.
    text = stripLeadingOhAhInterjections(text);
    let trimmed = text.trim();
    if (/^(-|\–|\—)(\s*(-|\–|\—))*$/g.test(trimmed)) return '';

    let cleaned = text.replace(/^<[^>]+>\s*(?:uh|uhh|uhhh|uhm|uhmm|um|umm|ehm|erm|err|mwah|ă|ăă|ăăă|uu)[!.,?\s-]*\s*<\/[^>]+>$/gmi, '');
    // Elimină bâlbâielile/interjecțiile de ezitare care nu aduc informație.
    // IMPORTANT: includem și punctul în delimitatori; altfel „ăă...” / „mhm...”
    // nu sunt prinse corect deoarece regex-ul vechi nu considera „.” delimitator.
    // „ă{2,}” prinde și forme precum „ăăă...”, nu doar exact „ăă”.
    // Eliminăm doar ezitări evidente; reacțiile ambigue rămân sub controlul promptului contextual.
    const hesitationToken = '(?:mwah|ă{1,}|ehm|er+m?|um+m?|uh+m?)';

    // Dacă ezitarea este la final și a fost precedată de virgulă/„;”/„:”,
    // eliminăm și punctuația rămasă înaintea ei și păstrăm o elipsă naturală.
    cleaned = cleaned.replace(
        new RegExp('[,;:]\\s*' + hesitationToken + '[,;:.!?…]*\\s*$', 'gmi'),
        '...'
    );

    cleaned = cleaned.replace(
        new RegExp('(^|[\\s,;:.!?…])' + hesitationToken + '(?=[\\s,;:.!?…]|$)[,;:.!?…]*', 'gmi'),
        '$1'
    ).trim();

    // Elimină bâlbâiala de tip „V-vin”, „M-mă”, „S-sunt” → „Vin”, „Mă”, „Sunt”.
    cleaned = cleaned.replace(/\b([A-Za-zĂÂÎȘȚăâîșț])-\1(?=[A-Za-zĂÂÎȘȚăâîșț])/gi, '$1');

    // Varianta foarte scurtă „E-E”, „A-A”, „M-M” etc.
    // Regex-ul de mai sus nu o prinde deoarece cere încă o literă după al doilea caracter.
    // Se elimină doar repetarea unei singure litere, nu cuvinte întregi.
    cleaned = cleaned.replace(
        /\b([A-Za-zĂÂÎȘȚăâîșț])\s*[-–—]\s*\1\b/gi,
        '$1'
    );

    // Elimină repetarea imediată a aceluiași cuvânt după o pauză: „o să... o să...” → „o să...”.
    cleaned = cleaned.replace(/\b([A-Za-zĂÂÎȘȚăâîșț]+(?:\s+[A-Za-zĂÂÎȘȚăâîșț]+)?)\s*\.{2,}\s*\1\b/gi, '$1...');
    // Dacă după colaps rămâne punctul final al replicii, evităm „....”.
    cleaned = cleaned.replace(/\.{4,}/g, '...');

    cleaned = cleaned.replace(/[^\S\r\n]+/g, ' ');

    // După eliminarea unei ezitări, repară majuscula de început de propoziție.
    // Nu forța majuscula după „...” (propoziția continuă) și nici după abrevieri uzuale (dl., dna, nr., etc.).
    cleaned = cleaned.replace(/(^|(?<!\.)(?<!\b(?:[Dd]l|[Dd]na|[Dd]r|[Nn]r|[Ee]tc|[Ee]x))[.!?]\s+)([a-zăâîșț])/g, (m, prefix, letter) => prefix + letter.toUpperCase());
    
    if (/^[-–—\s.?!,;:'"]+$/.test(cleaned)) return '';

    cleaned = cleaned.replace(/\\+/g, ' ');
    cleaned = cleaned.replace(/\b(nu|de|ce|pe|la)1\b/gi, '$1');

    // Normalizează apostroful curb și semnul „…”, apoi păstrează ghilimelele românești „ ” și “ ”.
    cleaned = cleaned.replace(/[\u2018\u2019]/g, "'").replace(/\u2026/g, '...');
    cleaned = cleaned.replace(/[^\u0000-\u024F\u1E00-\u1EFF\s.,!?:;\-–—'"()\[\]<>\/\u201C\u201D\u201E]/g, '');
    // Orice text între (...) sau [...] trebuie eliminat; filtrul dedicat rulează înainte
    // de traducere și din nou asupra textului final, după regulile proiectului.

    if (!cleaned.trim()) return '';

    cleaned = cleaned.replace(/\bman-ar\b/gi, 'mi-ar');
    cleaned = cleaned.replace(/\bman-a\b/gi, 'mi-a');
    cleaned = cleaned.replace(/(?<![\p{L}\p{N}_])[Dd]e ce man pas[aă](?![\p{L}\p{N}_])/giu, m => m[0] === m[0].toLowerCase() ? 'de ce mi-ar păsa' : 'De ce mi-ar păsa');
    cleaned = cleaned.replace(/\b[Dd]e ce man-ar pasa\b/gi, 'De ce mi-ar păsa');
    cleaned = cleaned.replace(/\bDe ce man spui\b/gi, 'De ce îmi spui');
    cleaned = cleaned.replace(/\bLasă-man\b/gi, 'Lasă-mă');
    
    cleaned = cleaned.replace(/(?<![\p{L}\p{N}_])șă-i(?![\p{L}\p{N}_])/gu, 'să-i');
    cleaned = cleaned.replace(/(?<![\p{L}\p{N}_])Șă-i(?![\p{L}\p{N}_])/gu, 'Să-i');
    cleaned = cleaned.replace(/(?<![\p{L}\p{N}_])șă-ți(?![\p{L}\p{N}_])/gu, 'să-ți');
    cleaned = cleaned.replace(/(?<![\p{L}\p{N}_])Șă-ți(?![\p{L}\p{N}_])/gu, 'Să-ți');
    cleaned = cleaned.replace(/(?<![\p{L}\p{N}_])șă-și(?![\p{L}\p{N}_])/gu, 'să-și');
    cleaned = cleaned.replace(/(?<![\p{L}\p{N}_])Șă-și(?![\p{L}\p{N}_])/gu, 'Să-și');

    cleaned = cleaned.replace(/^[aA]?[,\s]*mi s-a plătit\.?/gi, 'Mi-am primit banii.');
    cleaned = cleaned.replace(/^[aA]?[,\s]*am fost plătit[aă]?\.?/gi, 'Mi-am primit banii.');
    cleaned = cleaned.replace(/(?<![\p{L}\p{N}_])distraggă(?![\p{L}\p{N}_])/giu, 'distragă');

    return cleaned;
}

function applyDeterministicSemanticFix(original, translation) {
    if (translation == null) return translation;

    const originalNorm = String(original || '')
        .toLowerCase()
        .replace(/[“”„”]/g, '"')
        .replace(/\s+/g, ' ')
        .trim();

    let text = String(translation);
    const textNorm = text.toLowerCase().replace(/\s+/g, ' ').trim();

    // Aceste corecții sunt intenționat STRICTE: se aplică numai când
    // originalul englezesc corespunde clar cazului deja verificat.
    if (/^get out of my head[.!?]*$/.test(originalNorm)) {
        if (/^ieși-mi din cap[.!?]*$/.test(textNorm) ||
            /^ieși din minte[.!?]*$/.test(textNorm)) {
            return 'Ieși din capul meu.';
        }
    }

    if (/^it['’]s a fucking oven in here[.!?]*$/.test(originalNorm)) {
        if (/^e un cuptor (?:dracului|al dracului|al naibii) aici[.!?]*$/i.test(textNorm)) {
            return 'E un cuptor al naibii aici.';
        }
    }

    if (/^and then we f(?:u|\*)cked to celebrate[.!?]*$/.test(originalNorm) ||
        /^and then we f(?:u|\*)\*{2,}t to celebrate[.!?]*$/.test(originalNorm)) {
        if (/^și pe urmă (?:am fut-o|am fumat-o|am f\*+ut|am f\*+t) ca să sărbătorim[.!?]*$/i.test(textNorm)) {
            return 'Și pe urmă ne-am futut ca să sărbătorim.';
        }
    }

    return text;
}

function splitSubtitleIntoTwoLines(value, maxChars = 43) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return [];
    if (text.length <= maxChars) return [text];

    const candidates = [];
    for (let i = 1; i < text.length - 1; i++) {
        if (text[i] !== ' ') continue;
        const left = text.slice(0, i).trim();
        const right = text.slice(i + 1).trim();
        if (!left || !right || left.length > maxChars || right.length > maxChars) continue;

        const leftLastWord = (left.match(/\S+$/) || [''])[0].toLowerCase();
        const rightFirstWord = (right.match(/^\S+/) || [''])[0].toLowerCase();
        let penalty = 0;
        if (/^(?:a|al|ai|ale|cu|de|din|în|la|lângă|pe|pentru|prin|să|și|un|o|ori|că|ca|îi|i|le|mi|ți|ne|vă)$/i.test(leftLastWord)) penalty += 8;
        if (/^(?:de|din|în|la|pe|pentru|și|să|cu|că|care|un|o)$/i.test(rightFirstWord)) penalty += 3;
        if (/[.!?…,:;]$/.test(left)) penalty -= 4;
        const balancePenalty = Math.abs(left.length - right.length) * 0.35;
        candidates.push({ left, right, score: balancePenalty + penalty });
    }
    if (candidates.length) {
        candidates.sort((a, b) => a.score - b.score);
        return [candidates[0].left, candidates[0].right];
    }

    // If the complete text is longer than two 43-character lines, a strict
    // 43/43 layout is mathematically impossible without rewriting or dropping
    // words. Keep exactly two balanced lines and preserve the full translation.
    const allBreaks = [];
    for (let i = 1; i < text.length - 1; i++) {
        if (text[i] !== ' ') continue;
        const left = text.slice(0, i).trim();
        const right = text.slice(i + 1).trim();
        if (!left || !right) continue;
        const leftLastWord = (left.match(/\S+$/) || [''])[0].toLowerCase();
        const penalty = /^(?:a|al|ai|ale|cu|de|din|în|la|pe|pentru|prin|să|și|un|o|că|ca)$/i.test(leftLastWord) ? 8 : 0;
        allBreaks.push({ left, right, score: Math.abs(left.length - right.length) + penalty });
    }
    if (allBreaks.length) {
        allBreaks.sort((a, b) => a.score - b.score);
        return [allBreaks[0].left, allBreaks[0].right];
    }
    return [text];
}

function formatSubtitleLayout(value) {
    const rawLines = String(value || '')
        .replace(/\r/g, '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
    if (!rawLines.length) return ' ';

    let entries = [];
    for (const raw of rawLines) {
        // Split inline two-speaker dialogue even when the first speaker already
        // has a leading dash. A separator after completed sentence punctuation
        // is required so ordinary hyphenated prose is not split accidentally.
        const prefixedDoubleDialogue = raw.match(/^\s*[-–—]\s*(.+?[.!?…])\s+[-–—]\s*(.+)$/);
        if (prefixedDoubleDialogue) {
            entries.push({ text: prefixedDoubleDialogue[1].trim(), dialogue: true });
            entries.push({ text: prefixedDoubleDialogue[2].trim(), dialogue: true });
            continue;
        }
        const inlineDialogue = raw.match(/^\s*(.+?[.!?…])\s+[-–—]\s+(.+)$/);
        if (inlineDialogue) {
            entries.push({ text: inlineDialogue[1].trim(), dialogue: true });
            entries.push({ text: inlineDialogue[2].trim(), dialogue: true });
            continue;
        }

        // Preserve a speaker marker if present. Normalize it to "- " and use
        // a capital letter after the dash, as required by SubStudio formatting.
        const marked = raw.match(/^[-–—]+\s*(.*?)\s*$/);
        if (marked && marked[1]) {
            entries.push({ text: marked[1].trim(), dialogue: true });
            continue;
        }
        entries.push({ text: raw, dialogue: false });
    }

    // If the model produces more than two lines, keep the complete content and
    // compact the overflow into the second line instead of silently truncating it.
    if (entries.length > 2) {
        const first = entries[0];
        const remainder = entries.slice(1).map(entry => entry.dialogue ? `- ${entry.text}` : entry.text).join(' ');
        entries = [first, { text: remainder, dialogue: false }];
    }

    const capFirst = value => String(value || '').replace(/^([a-zăâîșț])/u, ch => ch.toLocaleUpperCase('ro-RO'));
    const emit = entry => entry.dialogue ? `- ${capFirst(entry.text)}` : entry.text;

    if (entries.length === 1) {
        const entry = entries[0];
        if (entry.dialogue) {
            const parts = splitSubtitleIntoTwoLines(entry.text, 41);
            if (parts.length === 2) return `- ${capFirst(parts[0])}\n${parts[1]}`;
            return `- ${capFirst(parts[0])}`;
        }
        return splitSubtitleIntoTwoLines(entry.text, 43).join('\n') || ' ';
    }

    // Two explicit speaker lines must stay two speaker lines; never remove the
    // dashes or wrap them into extra lines. The translation prompt asks the model
    // to rephrase overly long dialogue before returning it.
    if (entries.length === 2 && entries.every(entry => entry.dialogue)) {
        return entries.map(emit).join('\n');
    }

    if (entries.length === 2 && entries.some(entry => entry.dialogue)) {
        return entries.map(emit).join('\n');
    }

    if (entries.every(entry => entry.text.length <= 43)) {
        return entries.map(entry => entry.text).join('\n');
    }
    return splitSubtitleIntoTwoLines(entries.map(entry => entry.text).join(' '), 43).join('\n') || ' ';
}

function formatSubtitleLine(text) {
    if (!text) return ' ';

    text = deepCleanSubtitleText(text);
    if (!text.trim()) return ' ';

    let lowerText = text.toLowerCase();

    // Doar litere mici izolate (trunchieri „c”/„s” → „că”/„să”); majusculele („Vitamina C”, „Harry S. Truman”) rămân neatinse.
    text = text.replace(/(?<!\d)(^|[\s])([cs])(?=[\s.,!?:;]|$)/gm, function(match, spatiu, litera) {
        return spatiu + litera + 'ă';
    });
    text = text.replace(/(^|[\s])([Aa]dic)(?=[\s.,!?:;]|$)/gm, '$1$2ă');
    text = text.replace(/ţ/g, 'ț').replace(/Ţ/g, 'Ț').replace(/ş/g, 'ș').replace(/Ş/g, 'Ș');
    text = text.replace(/<[^>]+>/g, '');

    // Corecții mecanice certe confirmate în verificările recente.
    // Sunt intenționat specifice pentru a evita corecții globale riscante.
    const dictionar = [
        // Forme generate variabil de model pentru aceeași construcție semantică.
        // Sunt limitate la expresii confirmate ca greșite în acest proiect.
        [/\b(?:Iași|Iasi|Ieși|Iesi)[- ]mi din cap\b/gi, 'Ieși din capul meu'],
        [/\b(?:Ia|I-a) mâna după mine\b/gi, 'Ia mâna de pe mine'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])Și pe urmă am fut-o ca să sărbătorim(?![A-Za-zĂÂÎȘȚăâîșț])/gi, (m) => (m[0] === m[0].toLowerCase() ? 'și pe urmă ne-am futut ca să sărbătorim' : 'Și pe urmă ne-am futut ca să sărbătorim')],
        [/\b(?:Și|Si) pe urmă am f\*{2,}ut ca să sărbătorim\b/gi, 'Și pe urmă ne-am futut ca să sărbătorim'],
        [/\b(?:Și|Si) pe urmă am f\*{2,}t ca să sărbătorim\b/gi, 'Și pe urmă ne-am futut ca să sărbătorim'],
        [/\bE un cuptor dracului aici\b/gi, 'E un cuptor al naibii aici'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])Rezoluția Concurrentă(?![A-Za-zĂÂÎȘȚăâîșț])/g, 'Rezoluția Concurentă'],
        [/\bun cerc de încrederi\b/gi, 'un cerc de încredere'],
        [/\bcuando îți zic\b/gi, 'când îți zic'],
        [/\bmult așteptatului film\b/gi, 'mult așteptatul film'],
        [/\bnăibii\b/gi, 'naibii'],
        [/\blar că sunteți aici\b/gi, 'că sunteți aici'],
        [/\bn-am gânit\b/gi, 'n-am gândit'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])nicodată(?![A-Za-zĂÂÎȘȚăâîșț])/gi, 'niciodată'],
        [/\bNu iau sifilis de Schifter\b/gi, 'Nu iau sifilis de Shapeshifter'],
        [/\bCa sămă înveți\b/gi, 'Ca să mă înveți'],
        [/\bCititoare de minți\b/gi, 'Cititoare de gânduri'],
        [/\bA dat C-ul din sac\b/gi, 'S-a aflat secretul'],
        [/\bsingurul tău prieten rămas pe dracu\'\b/gi, 'singurul tău prieten care ți-a mai rămas'],
        [/\bsub pământ jucând biliard în buzunar\b/gi, 'sub pământ frecând menta'],

        [/\bjhonson\b/gi, 'Johnson'],
        [/\bsuch a detailed indictment\b/gi, 'un rechizitoriu atât de detaliat'],
        [/\bHowever,\b/gi, 'Cu toate acestea,'],
        [/\bdilettante\b/gi, 'diletant'],
        [/\babroach\b/gi, 'abordare'],
        [/\bfrom project\b/gi, 'din proiect'],
        [/\bbanca acuzaților bancul acuzaților\b/gi, 'pe banca acuzaților'],
        [/(?<![\p{L}\p{N}_])în joi(?![\p{L}\p{N}_])/giu, 'joi'],
        [/\bde la embedding itself in a mudbank\.?/gi, 'de la a se înfige într-un mal de noroi.'],
        [/\bembedding itself in a mudbank\.?/gi, 'a se înfige într-un mal de noroi.'],
        [/\bN-a fost nic67\b/gi, 'Nu era niciun loc aici?'],
        // Corecție contextuală păstrată; regula globală „background → trecut” a fost eliminată.
        [/\bbackground juridic\b/gi, 'trecut juridic'],
        [/\bCă\.E\.A\./gi, 'A.E.C.'],
        [/\bpro Jean Tatlock\b/gi, 'despre Jean Tatlock'],
        [/(?<![\p{L}\p{N}_])în ș\s*\./giu, 'în șah.'],
        [/(?<![\p{L}\p{N}_])în ș(?![\p{L}\p{N}_])/giu, 'în șah'],
        [/\bsomom\b/gi, 'somon'],
        [/\bdilettant\b/gi, 'diletant'],
        [/\bcowboys\b/gi, 'cowboy'],
        [/\bThey need us\.?\b/gi, 'Au nevoie de noi.'],
        [/\bMaybe a little too well,?\s*Robert\.?\b/gi, 'Poate puțin prea bine, Robert.'],
        [/\bInterestingly enough,?\b/gi, 'Destul de interesant,'],
        [/\bthese men\b/gi, 'acești oameni'],
        [/\beverybody take a welder's glass\b/gi, 'toată lumea să ia o mască de sudură'],
        [/Everybody take a welder's glass\./gi, 'Toată lumea să ia o mască de sudură.'],

        // Etichete de personaje uitate în engleză
        [/^DRIVER:\s*/gmi, 'ȘOFER: '],
        [/\bDRIVER:\s*/gi, 'ȘOFER: '],
        [/^GUARD:\s*/gmi, 'GARDĂ: '],
        [/\bGUARD:\s*/gi, 'GARDĂ: '],
        [/^OFFICER:\s*/gmi, 'OFIȚER: '],
        [/\bOFFICER:\s*/gi, 'OFIȚER: '],
        [/^COP:\s*/gmi, 'POLIȚIST: '],
        [/\bCOP:\s*/gi, 'POLIȚIST: '],

        // Scăpări și anomalii identificate anterior
        [/\bCcat\b/gi, 'Căcat'],
        [/\bbănuiuiesc\b/gi, 'bănuiesc'],
        [/(?<![\p{L}\p{N}_])împotriva asta(?![\p{L}\p{N}_])/giu, 'împotriva acestui lucru'],
        [/\bI tăiați capul\b/gi, 'Îi tăiați capul'],
        [/\bnam niciun fel\b/gi, 'n-am niciun fel'],
        [/\bnarțiune\b/gi, 'narațiune'],
        [/\binteriorul acestei cupe\b/gi, 'interiorul acestei cuști'],
        [/\bspuneți-i saluta\b/gi, 'spuneți-i salut'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])cea mai izolatã(?![A-Za-zĂÂÎȘȚăâîșț])/gi, 'cea mai izolată'],
        [/\brebuie să știm\b/gi, 'trebuie să știm'],
        [/\buficient de mult\b/gi, 'suficient de mult'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])îi cureț(?![A-Za-zĂÂÎȘȚăâîșț])/gi, 'îi curăț'],
        [/\bArată foarte atleți\b/gi, 'Arată foarte atletici'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])în toată regla(?![A-Za-zĂÂÎȘȚăâîșț])/gi, 'în toată regula'],
        [/\bI se strânge noțul\b/gi, 'I se strânge lațul'],
        [/\bdeatât un câine\b/gi, 'decât un câine'],
        [/\bBandurile cu spini\b/gi, 'Benzile cu țepi'],
        [/\bacești tipii\b/gi, 'acești tipi'],
        [/\bla aeriport\b/gi, 'la aeroport'],
        [/\bVine un camioane\b/gi, 'Vine un camion'],
        [/\bDos beri\b/gi, 'Două beri'],
        [/\bbervezas\b/gi, 'beri'],
        [/\bTrapiste pline de praf\b/gi, 'Uși-capcană pline de praf'],
        [/\bl-ai tras în piepie\b/gi, 'l-ai tras în piept'],
        [/\bCâți-va insule\b/gi, 'Câțiva inși'],
        [/\bDRS inamic\b/gi, 'Dronă inamică'],
        [/\bce ai\?y\b/gi, 'ce ai?'],
        [/\bse molmoșește\b/gi, 'dă greș'],
        [/\bnu-mi mai aparține!\b/gi, 'că nu-mi mai aparține!'],
        [/\bscoateți-o pe mama pe insulă\b/gi, 'scoateți-o pe mama de pe insulă'],
        [/\bva face denunț\b/gi, 'îi va denunța'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])Ț-am cerut(?![A-Za-zĂÂÎȘȚăâîșț])/gi, (m) => (m[0] === m[0].toLowerCase() ? 'ți-am cerut' : 'Ți-am cerut')],
        [/\bcearsăfuri\b/gi, 'cearșafuri'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])șă ne ținem(?![A-Za-zĂÂÎȘȚăâîșț])/gi, 'să ne ținem'],
        [/\boevacuare\b/gi, 'o evacuare'],
        [/\btat-tu\b/gi, 'tatăl tău'],
        [/\btat-meu\b/gi, 'tatăl meu'],
        [/\bmerici\b/gi, 'meriți'],
        [/\bcuânt\b/gi, 'cuvânt'],
        [/\bbrioșelea aia\b/gi, 'brioșele alea'],
        [/Sânișor Kournikova/gi, 'Rusoaica Pectorală'],
        [/fundul tău strâns/gi, 'fundul tău scorțos'],
        [/cafondist/gi, 'mojic'],
        [/Pu[țt]in-Kournikova/gi, 'Rusoaica Pectorală'],
        [/ghicercici/gi, 'ghicești'],
        [/dafirma/gi, 'da afară'],
        [/judicativ[aă]/gi, 'plină de prejudecăți'],
        [/le-atâmită/gi, 'le tâmpește'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])Eu poartă(?![A-Za-zĂÂÎȘȚăâîșț])/gi, (m) => (m[0] === m[0].toLowerCase() ? 'eu port' : 'Eu port')],
        [/\bAleile aia\b/gi, 'Chestia aia'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])s-(ți|l)(?![A-Za-zĂÂÎȘȚăâîșț])/gi, (m, a) => (m[0] === 'S' ? 'Să-' : 'să-') + a],
        [/\bEu poart\b/gi, 'Eu port'],
        [/\btîmpenie\b/gi, 'tâmpenie'],
        [/\bjobul asta\b/gi, 'jobul ăsta'],
        [/\bNu știe despre vorbește\b/gi, 'Nu știe despre ce vorbește'],
        [/\bom străzii\b/gi, 'om al străzii'],
        [/\bcoatul\b/gi, 'cotul'],
        [/\bketchuipurile\b/gi, 'ketchupurile'],
        [/\ble-atâmbesc\b/gi, 'le amețesc'],
        [/\buții\b/gi, 'utili'],
        [/\bfute-n cur de prostie\b/gi, 'al dracului de prost'],
        [/\bsevraică\b/gi, 'mahmură'],
        [/\bhoțul afla-nărav o fi spart\b/gi, 'vreun hoț o fi spart'],
        [/\breînălța ea a trebuit\b/gi, 'ea a trebuit'],
        [/\ba fute-o pe o pește-clovn\b/gi, 'a futut un pește-clovn'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])țeață(?![A-Za-zĂÂÎȘȚăâîșț])/gi, 'țeavă'],
        [/\bnite amenzi\b/gi, 'niște amenzi'],
        [/\bFlore la ureche\b/gi, 'Floare la ureche'],
        [/\blaptepentru\b/gi, 'lapte pentru'],
        [/\bc-total\b/gi, 'total'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])Întreabă--i(?![A-Za-zĂÂÎȘȚăâîșț])/gi, (m) => (m[0] === m[0].toLowerCase() ? 'întreabă-i' : 'Întreabă-i')],
        [/「/g, ''],
        [/\bdirectorenul\b/gi, 'directorul'],
        [/\bstorcești\b/gi, 'strivești'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])cea mai albitură(?![A-Za-zĂÂÎȘȚăâîșț])/gi, 'cea mai albă'],
        [/\bcroșetă-n branhii\b/gi, 'croșeu în branhii'],
        [/\bfătat de prostie\b/gi, 'futut de prostie'],
        [/\bpsihoopat\b/gi, 'psihopat'],
        [/\bregrei\b/gi, 'regreți'],
        [/\bo 26\b/gi, 'asta'],
        [/\bputiul\b/gi, 'puțoiul'],
        [/\bPlătitorul de pește\b/gi, 'Strivitorul de calcan'],
        [/\bCentura de Rugină\b/gi, 'Rust Belt'],
        [/\bm-ar ține de șase De șase\b/gi, 'mi-aș păzi spatele'],
        [/\batacat cuvântat\b/gi, 'atacat dur'],
        [/\bMica Nină\b/gi, 'Little Nina'],
        [/\bmass-media principală\b/gi, 'presa mainstream'],
        [/\bun drac de cuvânt\b/gi, 'o vorbă'],
        [/\bScoală-ți-o zile în șir\b/gi, 'Scoală-n puii mei non-stop'],
        [/\b(un)?\s*modist\s*(\d+)?\b/gi, 'un modest'],
        [/\bprânat\b/gi, 'prins'],
        [/\b(s|S)troș\b/gi, 'Strauss'],
        [/\bștiu la mașină\b/gi, 'știu să dactilografiez'],
        [/\bse bucură de prea multă binefacere\b/gi, 'sunt bineveniți'],
        [/\bce-ți veni\b/gi, 'ce-ai pățit'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])marșă de manevră(?![A-Za-zĂÂÎȘȚăâîșț])/gi, 'marjă de manevră'],
        // Nu șterge automat reacții de sine stătătoare („Ah!”, „Oh!”, „Aoleu!”);
        // eliminarea vocalizărilor fără sens este tratată contextual în filtrul dedicat.
        [/\bV Dumneata\b/gi, 'Dumneata'],
        [/\bnăscut Borden\b/gi, 'pe nume Borden'],
        [/\bca să o demonstr\b/gi, 'ca să o demonstrăm'],
        [/\bde ce n-a fost asocierile\b/gi, 'de ce n-au fost asocierile'],
        [/\bialaltăieri\b/gi, 'alaltăieri'],
        [/\beceam\b/gi, 'eram'],
        [/\bcei-o fi\b/gi, 'ce i-o fi'],
        [/\btoți leau\b/gi, 'șleau'],
        [/\bfeșciști\b/gi, 'fasciști'],
        [/(?<![\p{L}\p{N}_])Î j cunosc(?![\p{L}\p{N}_])/giu, 'Îi cunosc'],
        [/\bororbit\b/gi, 'orbit'],
        [/\bi-ale refuze\b/gi, 'să le refuze'],
        [/\bsecreției\b/gi, 'secretomaniei'],
        [/\baliții\b/gi, 'aliații'],
        [/\bnimiște\b/gi, 'niște'],
        [/\bclasifiat\b/gi, 'clasificat'],
        [/\bsomong\b/gi, 'somon'],
        [/\bopt bancă\b/gi, 'banca'],
        [/\bpa,\s*o să-ți\b/gi, 'păi, o să-ți'],
        [/\bSunt tot un an de uium\.?\b/gi, 'Eram un dezastru'],
        [/\bunnea\b/gi, 'un'],
        [/\bparuri\b/gi, 'pariuri'],
        [/\bpaharele lui Berzelius și poțiuni\b/gi, 'eprubetele și poțiunile'],
        [/\bniliște\b/gi, 'niște'],
        [/\bcalmază-te\b/gi, 'calmează-te'],
        [/\bbuclușă\b/gi, 'bucluc'],
        [/\bmai justifică scuzle\b/gi, 'scuză mijloacele'],
        [/\bcEA\b/g, 'cea'],
        [/\bilealalte\b/gi, 'celelalte'],
        [/\blu'\s*Oppenheimer\b/gi, 'lui Oppenheimer'],
        [/\bsommon\b/gi, 'somon'],
        [/\bmi-amintești bine\b/gi, 'îmi amintesc bine'],
        [/\bca s-o spunem pe drăcea-n față\b/gi, 'ca s-o spunem pe șleau'],
        [/\bceteva\b/gi, 'câteva'],
        [/\bpentru a obține concesii consemnând de la ruși\b/gi, 'pentru a obține garanții de la ruși'],
        [/\bfacem bomba sigură\b/gi, 'securizăm bomba'],
        [/\binteresată de provocate\b/gi, 'interesată de capcane'],
        [/\bjiul\b/gi, 'fel'],
        [/\bdupă o oră și 58 de minute\b/gi, 'în exact o oră și 58 de minute'],
        [/\bil voi suna pe Lloyd Garrison\b/gi, 'îl voi suna pe Lloyd Garrison'],
        [/\bpe banca acuzaților bancă\b/gi, 'pe banca acuzaților'],
        [/\bAlgebră e ca partitura\b/gi, 'Algebra este ca o partitură'],
        [/\bpropriz\b/gi, 'proprie'],
        [/\bÎ j sun\b/gi, 'Îl sun'],
        [/\bsticlă de sudor\b/gi, 'sticlă de sudură'],
        [/\bsomomon\b/gi, 'somon'],
        [/\bAcestcomitet\b/gi, 'Acest comitet'],
        [/\bLeft-wing political activities\b/gi, 'activități politice de stânga'],
        [/\bHitler's dead, it's true\b/gi, 'Hitler e mort, e adevărat'],
        [/\bProgress\b/gi, 'Progres'],
        [/\bBut Mr\. Borden was\b/gi, 'Dar domnul Borden a fost?'],
        [/\bThat's a very serious accusation, Senator\b/gi, 'Aceasta este o acuzație foarte gravă, senatore'],
        [/\bRural free deliveries\b/gi, 'Livrări poștale rurale'],
        [/\bfești\b/gi, 'fasciști'],
        [/\b2dansezi\b/gi, 'dansezi'],
        [/\bdespăre\b/gi, 'despre'],
        [/\bhabar navea\b/gi, 'habar n-avea'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])Eu acționează(?![A-Za-zĂÂÎȘȚăâîșț])/gi, (m) => (m[0] === m[0].toLowerCase() ? 'eu acționez' : 'Eu acționez')],
        [/\bSă te fwt\b/gi, 'Să te fut'],
        [/\bcolțișorezi\b/gi, 'încolțești'],
        [/\bcolțișorești\b/gi, 'încolțești'],
        [/\btreabei\b/gi, 'trebii'],
        [/\bnimer\b/gi, 'vreo'],
        [/\bvalorizez\b/gi, 'valorez'],
        [/\bn o să te\b/gi, 'n-o să te'],
        [/\bnaiba să the ia\b/gi, 'naiba să te ia'],
        [/\bCoche\b/gi, 'Mașină'],
        [/\bcervezas\b/gi, 'beri'],
        [/\bn-auzeam\b/gi, 'n-am auzit'],
        [/\bpropriutei\b/gi, 'propriei'],
        [/\bmi-a învățat\b/gi, 'm-a învățat'],
        [/\bcred că își vor recupera\b/gi, 'crede că își va recupera'],
        [/\bprima șoarece\b/gi, 'primul șoarece'],
        [/\bPrefeți\b/gi, 'Preferi'],
        [/\bniciunfel\b/gi, 'niciun fel'],
        [/\bUrco\b/gi, 'Urc-o'],
        [/\bn o să\b/gi, 'n-o să'],
        [/\bpenthouses-ul\b/gi, 'penthouse-ul'],
        [/\bpenthousul\b/gi, 'penthouse-ul'],
        [/\bîn a mea mea\b/gi, 'în puii mei'],
        [/\bTrapdoor-uri\b/gi, 'Uși-capcană'],
        [/\bTrapuri\b/gi, 'Capcane'],
        [/\bîn a naibii\b/gi, 'întreagă, la naiba'],
        [/\bAltor orte\b/gi, 'Alcuiva'],

        // Corecții mecanice certe observate în verificările recente.
        // Erori recurente confirmate: corecții native, deterministe.
        [/\bca să\.\.\.rbătorim\b/gi, 'ca să sărbătorim'],
        [/\bM-am cerut în căsătorie cu\b/gi, 'L-am cerut în căsătorie pe'],
        [/\bCitească-gânduri\b/gi, 'Cititoare de gânduri'],
        [/\bdemocracția\b/gi, 'democrația'],
        [/\bMă reasigur în patru ani\b/gi, 'Să fiu realeasă în patru ani'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])S-a dus totul pe râpă(?![A-Za-zĂÂÎȘȚăâîșț])/gi, (m) => (m[0] === m[0].toLowerCase() ? 's-a dus totul de râpă' : 'S-a dus totul de râpă')],
        [/\bo bullet\b/gi, 'un glonț'],
        [/\bmergem orbești\b/gi, 'mergem orbește'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])o favoră(?![A-Za-zĂÂÎȘȚăâîșț])/gi, 'o favoare'],
        [/\bMă închizi într-o cușcă\s*\/\s*dacă nu accept să fii arma ta\b/gi, 'Mă închizi într-o cușcă / dacă nu accept să fiu arma ta'],
        [/\bȘi pe urmă am fumat-o de sărbătoare\b/gi, 'Și pe urmă ne-am futut ca să sărbătorim'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])Rezoluția Concurrentă(?![A-Za-zĂÂÎȘȚăâîșț])/gi, (m) => (m[0] === m[0].toLowerCase() ? 'rezoluția Concurentă' : 'Rezoluția Concurentă')],
        [/\bun cerc de încrederi\b/gi, 'un cerc de încredere'],

        // Sunt intenționat conservative: repară doar forme clar corupte/typo.
        [/\bDe ce (?:ne|mi|ți|v|i)-ar pasa\b/gi, m => m.replace(/pasa\b/gi, 'păsa')],
        [/\bmizerijile\b/gi, 'mizeriile'],
        [/\bfrecându-menta\b/gi, 'frecând menta'],
        [/\bT-Ar trebui\b/g, 'Ar trebui'],
        [/\btuți\b/gi, 'toți'],
        [/(?<![\p{L}\p{N}_])țin-ținta(?![\p{L}\p{N}_])/giu, 'ținta'],
        [/\bfãcut-o\b/gi, 'făcut-o'],
        [/\bca i-au făcut\b/gi, 'cum i-au făcut'],
        [/\bpână la adânci bătrânețe\b/gi, 'până la adânci bătrâneți'],
        [/(?<![\p{L}\p{N}_])reeligitată(?![\p{L}\p{N}_])/giu, 'realeasă'],
        [/\bîn ourselves\b/gi, 'înșine'],
        [/\bMă-nvățați\b/g, 'mă-nvățați'],
        [/\bmi l-a învățat tata\b/gi, 'm-a învățat tata'],
        [/\bvirusul ăla naibii\b/gi, 'virusul ăla al naibii'],
        [/\bDe ce ne-ar pasa\b/gi, 'De ce ne-ar păsa'],
        [/\bDe ce i-ar pasa\b/gi, 'De ce i-ar păsa'],
        [/\bcomuniștii erau periculoase\b/gi, 'comuniștii erau periculoși'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])în ziua în care(?![A-Za-zĂÂÎȘȚăâîșț])/gi, 'în ziua în care'],
        [/\.icon\b/gi, ''],

        // „fucking” calchiat: „Ce a dracului…” nu există în română.
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])(ce|cine|unde|cum|când|cât|care) a (dracului|naibii)(?![A-Za-zĂÂÎȘȚăâîșț])/gi,
            (m, w, k) => w + ' ' + (k.toLowerCase() === 'dracului' ? "dracu'" : 'naiba')],
        // „nici o/un” → „nicio/niciun” (nu se atinge „nici un singur” și structurile „nici… nici…”).
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])nici (o|un)(?![A-Za-zĂÂÎȘȚăâîșț])(?!\s+singur)/gi,
            (m, a, offset, whole) => {
                const rest = String(whole).slice(offset + m.length);
                const before = String(whole).slice(0, offset);
                if (/(?<![A-Za-zĂÂÎȘȚăâîșț])nici(?![A-Za-zĂÂÎȘȚăâîșț])/i.test(rest) || /(?<![A-Za-zĂÂÎȘȚăâîșț])nici(?![A-Za-zĂÂÎȘȚăâîșț])/i.test(before)) return m;
                return (m[0] === 'N' ? 'N' : 'n') + 'ici' + a.toLowerCase();
            }],
        // Imperativ trunchiat: „păstreaz-o” → „păstrează-o”.
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])([a-zăâîșț]+ea)z-(o|l|i|le|mi|ți|ne|vă)(?![A-Za-zĂÂÎȘȚăâîșț])/gi, (m, stem, cl) => stem + 'ză-' + cl],

        // Numerale: „de” se folosește de la 20 în sus sau când numărul se termină în 00
        // („20 de ani”, „100 de dolari”) și NU se folosește pentru 1–19 („15 ani”).
        // Se aplică doar numerelor scrise cu cifre, urmate direct de o unitate/numărătoare uzuală.
        [/(?<![\d.,:])(\d{1,3}(?:\.\d{3})+|\d+)\s+(ani|dolari|lei|euro|minute|secunde|ore|zile|săptămâni|luni|metri|kilometri|kilograme|grame|litri|oameni|persoane|ori|grade|mile|picioare|milioane|miliarde|mii|lire|cenți|bani|tone)(?![\p{L}\d])/giu,
            (m, num, noun) => {
                const n = Number(String(num).replace(/\./g, ''));
                const lastTwo = n % 100;
                return (lastTwo === 0 || lastTwo >= 20) ? `${num} de ${noun}` : m;
            }],
        [/(?<![\d.,:])(\d+)\s+de\s+(ani|dolari|lei|euro|minute|secunde|ore|zile|săptămâni|luni|metri|kilometri|kilograme|grame|litri|oameni|persoane|ori|grade|mile|picioare|milioane|miliarde|mii|lire|cenți|bani|tone)(?![\p{L}\d])/giu,
            (m, num, noun) => {
                const lastTwo = Number(num) % 100;
                return (lastTwo >= 1 && lastTwo <= 19) ? `${num} ${noun}` : m;
            }],

        // Spațiere la punctuație: „bine,dar” → „bine, dar”; „Da , nu” → „Da, nu”; „Ce ?” → „Ce?”.
        [/(?<=\p{Ll}),(?=\p{L})/gu, ', '],
        [/(?<=[\p{L}\d])[ \t]+([,;?!])/gu, '$1']
    ];

    for (let i = 0; i < dictionar.length; i++) {
        text = text.replace(dictionar[i][0], dictionar[i][1]);
    }

    return formatSubtitleLayout(text);
}

// ============================================================
// MASTER CINEMATIC TRANSLATION PROMPT
// ============================================================

const MASTER_TRANSLATION_PROMPT = `MISSION
Translate every supplied English subtitle block into natural, modern spoken Romanian for films and TV. Localize the intended meaning and tone; do not copy English word order when it sounds unnatural in Romanian.

OUTPUT — CRITICAL
- Return ONLY a valid JSON array, with exactly one object for every supplied ID, in the original order.
- Every object must have exactly these fields: {"id": integer, "text": "Romanian translation"}.
- Preserve IDs exactly. Never omit, duplicate, invent, merge, or move content to a neighboring ID.
- Input IDs may contain gaps when subtitle blocks were filtered before translation. Never renumber by position or infer an ID from its neighbors: copy each supplied ID exactly, even when the numbers are not consecutive.
- Before returning, verify that every text belongs to the English block with the same ID; do not shift translations forward or backward when a block is unusual, numeric, empty-looking, or difficult to translate.
- Do not return markdown, code fences, comments, or explanations.

TRANSLATION AND CONTEXT
- Translate every meaningful sentence, phrase, joke, idiom, slang expression, and fragment into Romanian. Preserve names and established foreign expressions only when they genuinely belong in the source.
- MUSIC LYRICS EXCLUSION — The preprocessing code removes text enclosed by paired music-note markers (♪...♪, ♫...♫, ♬...♬, ♩...♩) BEFORE this prompt is built. Such lyrics must not appear in this request. Translate only the remaining real dialogue, including dialogue sharing a source block with lyrics; never invent replacement text for removed song lyrics. This applies to regular and SDH subtitles and must not remove non-song dialogue.
- Use neighboring English subtitles and the supplied Romanian context only to understand the scene, speaker, references, grammar, jokes, and continuity. Translate only the text belonging to the current ID.
- If a sentence continues across IDs, understand the whole sentence but keep each fragment under its original ID. Never move words between subtitle IDs.
- If the English block begins with a lowercase letter, or the previous block ends without terminal punctuation, it continues the previous sentence: begin its Romanian text with a lowercase letter unless the first word is a proper noun.
- Preserve the complete meaning: who performs the action, who or what receives it, location versus direct object, possession, negation, tense, person, gender, number, relationships, humor, and emotional intent.
- Use contemporary, idiomatic, spoken Romanian. Avoid literal calques, awkward English syntax, stiff or overly formal phrasing, and childish or timid wording that does not match the character.
- Preserve the original level of directness, intimacy, vulgarity, sarcasm, hostility, and informality. Do not censor or soften explicit dialogue, but do not make it more vulgar than the source.
- When the source explicitly names an anatomical or sexual term, use an accurate Romanian equivalent. Do not replace it with vague euphemisms such as „jos” or „acolo”. Preserve the grammatical relationship too: for example, “the sound that dries my vagina” means „sunetul care-mi usucă vaginul”, not „sunetul care mă usucă în vagin”.
- Preserve singular/plural, gender, and the identity of the object. A singular source noun such as “a hat” must not become plural „căciuli”. Do not add diminutives such as „căciuliță” unless smallness, affection, or a diminutive is actually expressed by the source.
- Translate idioms and profanity by their function in context, not by mechanically matching each English word. For example, “fucking” may be an intensifier, an insult, or a literal verb; choose the Romanian equivalent for that function.
- Romanian profanity: after an interrogative word use „dracu'” or „naiba” directly („Ce dracu' faci?”, „Despre ce naiba vorbești?”, „Cine dracu' ești?”); NEVER write „ce a dracului” or „cine a dracului”. As an intensifier use „al naibii de”, „la naiba”, „pe naiba”, or put „al naibii/al dracului” after a masculine noun group. Do not append „dracului” to every sentence and do not keep the English word order of “fucking”; often it is better dropped or rendered by a natural interjection. Examples: “What the fuck is in Switzerland?” → „Ce dracu' e în Elveția?”; “No fucking way.” → „Nici gând, la naiba.”; “It's a fucking disaster.” → „E un dezastru al naibii.”; “Shut the fuck up.” → „Taci dracului din gură.”
- Choose terms of endearment according to the relationship and context; do not translate “babe”, “honey”, or “baby” mechanically every time.
- Translate “But” as „Dar” when it begins a clause. Do not leave ordinary English dialogue untranslated.
- Use correct Romanian grammar, spelling, punctuation, and diacritics (ă, â, î, ș, ț). Use complete real Romanian words; never truncate, merge, invent, or corrupt a word. Check pronouns, clitics, prepositions, conjugation, and agreement.
- Convert ordinary imperial measurements to metric where natural and safe: feet to metres, miles to kilometres, pounds to kilograms, Fahrenheit to Celsius. Do not convert plot-critical or idiomatic measurements. Translate “lakh” as 100,000 and “crore” as 10 million when relevant.

ROMANIAN ACCURACY RULES
- Register: use informal „tu/voi” by default (friends, family, peers, partners, children, casual speech). Use „dumneavoastră” only when the source clearly signals formality: “sir/ma'am”, “Mr./Mrs./Dr./Officer/Professor/Your Honor” addressed respectfully, subordinate to superior, official, medical, military or courtroom settings. Once two speakers have a register, keep it for the whole scene (use the context lines to stay consistent). Render “sir/ma'am” as „domnule/doamnă”, “Mr./Mrs./Miss” as „domnul/doamna/domnișoara”, and keep ranks and titles natural („căpitane”, „domnule doctor”, „agent Smith”).
- Gender and number: English “you”, “I am tired”, “we were” do not show gender or number. Infer the gender and number of the speaker and of the person addressed from the neighboring lines (names, he/she, sir/ma'am, “guys”, “ladies”) and make adjectives, participles, pronouns and verbs agree („sunt obosită” / „sunt obosit”, „ați venit” for several people). If it is truly unknown, use the most common form; never write both forms with a slash.
- Names: keep names of people, characters, brands, bands and show/film titles as in the source unless an established Romanian form exists („Londra”, „Marea Britanie”). Do not decline or invent endings for foreign names, and spell each name the same way throughout.
- Direct object: use „pe” plus the clitic for people as direct objects („Îl iubesc pe Tom”, „Te văd pe tine”), not for things.
- Numerals: use „de” before the counted noun when the number is 20 or more or ends in 00 („20 de dolari”, „100 de ani”, „35 de minute”); omit it for 1–19 („15 dolari”, „3 ani”, „12 minute”).
- Calques: translate fixed phrases by their function, not word by word — “I mean”, “you know”, “like” (filler), “literally”, “actually”, “come on”, “hang on”, “my bad”, “I'm good”, “you're welcome”, “what's up”, “no way”, “give me a break”, “count me in”, “it's on me”. Do not mirror English passives, “-ing” chains or possessives („Mi-am spălat mâinile” → „M-am spălat pe mâini” when more natural). Tag questions (“right?”, “isn't it?”) become „nu?”, „da?” or „nu-i așa?”.
- Interjections: “Hmm?” / “Hm.” → „Hm?” / „Mda.” / „Mm.”; never „Mă?” or „Mă.” (a rude vocative in Romanian). Keep “Huh?” as „Hă?”.
- Agreement: check noun gender and number after every demonstrative or adjective („aceste microorganisme”, not „acești”); neuter nouns take masculine singular and feminine plural forms. Use „mi-e” / „nu mi-e frică”, not „mi-este”.
- Names and invented terms must have ONE Romanian form in the whole file. If a glossary is provided in the background block, follow it exactly; otherwise keep a nickname or invented term the same in every line and never produce spelling variants of the same name.
- Spelling: write every word completely and correctly („în”, „a vorbit”, „vorbea”, „s-a dus”); never merge, drop or swap letters.
- Before returning, re-read each line aloud in your head: if a native speaker would not say it, rewrite it more simply and naturally while keeping the full meaning.

SUBTITLE FORMATTING
- Keep each visible line at or below 43 characters whenever the wording allows. Use no more than TWO text lines per subtitle block.
- Split at natural phrase boundaries, not arbitrary points; if necessary, rephrase concisely without losing meaning.
- If the thought continues on the second visual line, start that line lowercase unless a proper noun or new sentence requires otherwise.
- If two speakers share one source block, keep both under the SAME ID on separate lines, each with “- ” and a capitalized first word. Never move a speaker to another ID.
- Preserve meaningful text from all source lines in the block. Do not silently drop content when fitting the layout.

INTERJECTIONS AND FILLERS
- Remove standalone filler sounds and meaningless hesitation tokens rather than returning them as translations. Typical disposable examples include “Um”, “Erm”, “Mwah”, “ă”, and “ăă” when they function only as hesitation/noise.
- NEVER preserve the English interjections “Oh” or “Ah” literally in Romanian output, whether they appear alone or at the start of a longer expression. Remove the leading “Oh/Ah” and translate the remaining message naturally: for example, “Oh, no!” → „Nu!” / „Vai, nu!” according to context; “Ah, yes!” → „Da!”; “Oh my God!” → „Doamne!”. The rest of the message must not be discarded.
- Preserve other meaningful acknowledgments, questions, reactions, or commands. Translate “Okay”, “Mhm/Mm-hmm” when they express agreement, “Huh?” when asking for clarification, “Uh-oh” when signaling trouble, “Wow/Whoa” when expressing surprise or warning, “Oops” when acknowledging a mistake, “Ouch/Ow” when indicating pain, “Shh/Psst” when requesting silence/attention, “Woo-hoo” when celebrating, “Phew” when expressing relief, and “Aha” when expressing realization.
- Use neighboring subtitles and the scene context to preserve the meaning of the remaining dialogue while removing standalone filler tokens. Repair punctuation and capitalization after removal.
- REGULĂ STRICTĂ PENTRU PARANTEZE: elimină integral orice text dintre paranteze rotunde (...) sau drepte [...], indiferent dacă este descriere sonoră, indicație de acțiune sau alt text. Acest conținut nu trebuie să apară în subtitrarea română. Dacă într-un bloc există dialog și în afara parantezelor, păstrează tot dialogul exterior.
- PENTRU DIALOG NORMAL, returnează traducerea ca text simplu: nu pune replica tradusă între paranteze rotunde sau drepte și nu adăuga paranteze decorative în jurul întregii traduceri. Parantezele/parantezele drepte nu se folosesc ca ambalaj pentru o replică normală.
- NEVER include non-dialogue sound effects, music cues, stage directions, or vocal-action captions in the Romanian subtitle output. Remove cues such as “(sighs)”, “[whistling]”, „(bufnește)”, „(șuierături)”, „(bufnire)” and „(plângând)” completely. Do not remove dialogue that mentions a sound, laughter, singing, or music when that dialogue is outside parentheses/brackets.

FINAL CHECK
Before returning JSON, proofread every translation against its English source and context. Verify meaning, natural Romanian syntax, direct-object/preposition relationships, singular/plural, register, explicitness, spelling, diacritics, line lengths, dialogue format, filler cleanup, and one-to-one ID alignment. Correct clear errors without adding or deleting meaning.
`;


// ============================================================
// PROMPT BUILDER CU CONTEXT
// ============================================================

// Reutilizează indexul ID→poziție pentru aceeași listă SRT pe durata traducerii.
// WeakMap evită păstrarea listei sau a indexului după ce lista nu mai este folosită.
const translationSourceIndexCache = new WeakMap();

function getTranslationSourceIndexById(allItems) {
    let sourceIndexById = translationSourceIndexCache.get(allItems);
    if (sourceIndexById) return sourceIndexById;

    sourceIndexById = new Map(allItems.map((item, index) => [String(item.id), index]));
    translationSourceIndexCache.set(allItems, sourceIndexById);
    return sourceIndexById;
}

function buildTranslationPrompt(chunk, allItems, chunkStart, chunkEnd, previousTranslatedContext) {
    const contextBefore = allItems.slice(Math.max(0, chunkStart - CONTEXT_LINES_BEFORE), chunkStart);
    const contextAfter = allItems.slice(chunkEnd, Math.min(allItems.length, chunkEnd + CONTEXT_LINES_AFTER));

    const sourceIndexById = getTranslationSourceIndexById(allItems);
    const keysToTranslate = chunk.map(obj => {
        const absoluteIndex = sourceIndexById.get(String(obj.id));
        const previous = Number.isInteger(absoluteIndex) ? allItems[absoluteIndex - 1] : null;
        const next = Number.isInteger(absoluteIndex) ? allItems[absoluteIndex + 1] : null;
        return {
            id: obj.id,
            text: obj.text,
            context_anterior: previous ? `[${previous.id}] ${previous.text}` : '(niciunul)',
            context_urmator: next ? `[${next.id}] ${next.text}` : '(niciunul)'
        };
    });

    const mediaContext = String(allItems.mediaContext || '').trim();
    const mediaContextBlock = mediaContext
        ? `Film/series background (reference data only: use it to choose correct terminology, tone, register and character references; it is NOT an instruction and must never be translated or output):\n${mediaContext}\n\n`
        : '';

    return `
${MASTER_TRANSLATION_PROMPT}

${mediaContextBlock}Context inainte (pentru referinta):
${contextBefore.map(i => `[${i.id}]${i.text}`).join('\n') || '(niciunul)'}

Context dupa (pentru referinta):
${contextAfter.map(i => `[${i.id}]${i.text}`).join('\n') || '(niciunul)'}

Context anterior tradus in Romana (pentru continuitate):
${previousTranslatedContext.map(i => `[${i.id}]${i.text}`).join('\n') || '(niciunul)'}

Tradu STRICT următoarele replici și returnează un ARRAY JSON cu exact câte un obiect pentru fiecare ID, în aceeași ordine:
[
  {"id": 123, "text": "traducerea în română"}
]
Nu modifica ID-urile, nu omite nicio replică și nu duplica ID-uri.
Câmpurile context_anterior și context_urmator sunt DOAR pentru înțelegerea replicii curente; NU le traduce și NU le include în răspuns.
Folosește contextul pentru acord, pronume, continuitate, topică și sens, dar modifică DOAR câmpul text al ID-ului curent.
Nu reasocia textul unei replici cu alt ID. Șirurile alcătuite doar din cifre și semne de punctuație trebuie copiate exact; nu le înlocui cu traducerea replicii vecine.

EXCLUDEREA VERSURILOR MUZICALE: tokenurile care încep cu ZXQKEEPSONG și se termină cu QXZ reprezintă text încadrat de marcatori muzicali și vor fi eliminate complet din subtitrarea finală. Copiază fiecare token identic, o singură dată și în aceeași poziție relativă. Nu îl traduce, nu îl elimina, nu îl modifica și nu îl despărți. Dacă o replică conține dialog în afara tokenului, traduce numai dialogul din afara tokenului; textul încadrat de marcatorii muzicali nu trebuie să apară în rezultat.

REPLICILE DE TRADUS:
${JSON.stringify(keysToTranslate, null, 2)}
`;
}

// Schema JSON folosește doar elemente acceptate de Gemini Structured Output.
// Numărul de elemente este fixat la dimensiunea calupului; ID-urile și textele
// sunt validate suplimentar în cod după parsare.
function buildTranslationResponseSchema(chunk) {
    if (!Array.isArray(chunk) || chunk.length === 0) {
        throw new Error('Nu se poate construi schema Gemini pentru un calup gol.');
    }

    const ids = chunk.map(item => String(item.id));
    if (new Set(ids).size !== ids.length) {
        throw new Error('Calupul conține ID-uri SRT duplicate; schema nu poate valida o mapare univocă.');
    }

    return {
        // Nu fixăm minItems/maxItems în schema trimisă la API: cardinalitatea
        // este verificată local prin compararea ID-urilor solicitate și primite.
        type: 'ARRAY',
        items: {
            type: 'OBJECT',
            properties: {
                id: { type: 'INTEGER', description: 'ID-ul original al replicii furnizate.' },
                text: { type: 'STRING', description: 'Traducerea română a replicii cu același ID.' }
            },
            required: ['id', 'text'],
            propertyOrdering: ['id', 'text']
        }
    };
}

// ============================================================
// API KEY STATE & MANAGEMENT
// ============================================================

// Un singur controler pentru toate cererile Gemini ale acestui proces Node.
// Astfel, două subtitrări procesate simultan nu își ignoră reciproc pauza de 429.
const geminiRequestControl = {
    active: 0,
    maxConcurrent: CONCURRENCY_LIMIT,
    targetConcurrent: CONCURRENCY_LIMIT,
    cooldownUntil: 0,
    nextStartAt: 0,
    lastStartAt: 0,
    waiters: new Set(),
    consecutive429: 0,
    consecutive5xx: 0,
    successesSinceThrottle: 0,
    // Pauza globală se activează numai pentru o limită comună indicată explicit
    // de răspunsul Google. Erorile per-proiect folosesc cooldown separat pe proiect;
    // dacă întregul pool intră în cooldown, recuperarea este serializată la o probă.
    recent429Projects: new Map(),
    global429PauseUntil: 0,
    global429LastTriggerAt: 0,
    global429LastWaveAt: 0,
    global429WaveCount: 0
};

function notifyGeminiRequestWaiters() {
    for (const wake of Array.from(geminiRequestControl.waiters)) wake();
}

function waitForGeminiRequestChange(timeoutMs = 250) {
    return new Promise(resolve => {
        let settled = false;
        let timer;
        const finish = () => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            geminiRequestControl.waiters.delete(finish);
            resolve();
        };
        geminiRequestControl.waiters.add(finish);
        timer = setTimeout(finish, Math.max(10, timeoutMs));
    });
}

async function acquireGeminiRequestSlot(requestStartIntervalMs = GEMINI_DEFAULT_REQUEST_START_INTERVAL_MS) {
    const requiredIntervalMs = Math.max(
        GEMINI_DEFAULT_REQUEST_START_INTERVAL_MS,
        Number(requestStartIntervalMs) || GEMINI_DEFAULT_REQUEST_START_INTERVAL_MS
    );
    while (true) {
        const now = Date.now();
        const cooldownMs = Math.max(0, geminiRequestControl.cooldownUntil - now);
        const lastStartAt = Number(geminiRequestControl.lastStartAt || 0);
        // Intervalul cerut de apelul curent este respectat și față de ultima pornire,
        // chiar dacă cererea anterioară avea intervalul normal de 1200 ms.
        const requestSpecificPacingMs = lastStartAt > 0
            ? Math.max(0, lastStartAt + requiredIntervalMs - now)
            : 0;
        const pacingMs = Math.max(0, geminiRequestControl.nextStartAt - now, requestSpecificPacingMs);

        if (cooldownMs <= 0 && pacingMs <= 0 && geminiRequestControl.active < geminiRequestControl.maxConcurrent) {
            geminiRequestControl.active++;
            const requestStartedAt = Date.now();
            geminiRequestControl.lastStartAt = requestStartedAt;
            geminiRequestControl.nextStartAt = requestStartedAt + requiredIntervalMs;
            let released = false;
            return () => {
                if (released) return;
                released = true;
                geminiRequestControl.active = Math.max(0, geminiRequestControl.active - 1);
                notifyGeminiRequestWaiters();
            };
        }

        const waitMs = cooldownMs > 0
            ? Math.min(cooldownMs, 1000)
            : pacingMs > 0 && geminiRequestControl.active < geminiRequestControl.maxConcurrent
                ? Math.min(pacingMs, 1000)
                : 1000;
        await waitForGeminiRequestChange(waitMs);
    }
}

function noteGeminiRequestSuccess(keyState = null) {
    const now = Date.now();
    const lane = getLaneForKeyState(keyState);
    let poolGateCleared = false;
    if (lane) {
        lane.lastTouchedAt = now;
        lane.consecutive429 = 0;
        lane.cooldownUntil = Math.min(Number(lane.cooldownUntil || 0), now);
        const pool = keyState?._keyPool;
        const previousPoolGate = Number(pool?._global429Until || 0);
        if (pool) updateGlobal429GateIfPoolExhausted(pool);
        poolGateCleared = previousPoolGate > now && Number(pool?._global429Until || 0) <= now;
    }
    if (poolGateCleared) notifyGeminiRequestWaiters();
    if (now < geminiRequestControl.cooldownUntil) return;

    if (geminiRequestControl.maxConcurrent < geminiRequestControl.targetConcurrent) {
        geminiRequestControl.successesSinceThrottle++;
        if (geminiRequestControl.successesSinceThrottle >= 3) {
            const previousLimit = geminiRequestControl.maxConcurrent;
            geminiRequestControl.maxConcurrent = Math.min(
                geminiRequestControl.targetConcurrent,
                geminiRequestControl.maxConcurrent + 1
            );
            geminiRequestControl.successesSinceThrottle = 0;
            if (geminiRequestControl.maxConcurrent >= geminiRequestControl.targetConcurrent) {
                geminiRequestControl.consecutive429 = 0;
                geminiRequestControl.consecutive5xx = 0;
            }
            console.log(`${c.green}✔ [Gemini Control] 3 cereri reușite; concurența crește controlat ${previousLimit}→${geminiRequestControl.maxConcurrent}/${geminiRequestControl.targetConcurrent}.${c.reset}`);
            notifyGeminiRequestWaiters();
        }
    } else {
        geminiRequestControl.consecutive429 = 0;
        geminiRequestControl.consecutive5xx = 0;
        geminiRequestControl.successesSinceThrottle = 0;
    }
}

function getGeminiPoolAvailability(keyStates, now = Date.now()) {
    const pool = Array.isArray(keyStates) ? keyStates : [];
    const candidates = pool.filter(state => {
        const lane = getLaneForKeyState(state);
        return !state.disabled && !lane?.disabled;
    });
    const entries = candidates.map(state => {
        const lane = getLaneForKeyState(state);
        return {
            state,
            lane,
            dailyUntil: Math.max(Number(state.dailyQuotaUntil || 0), Number(lane?.dailyQuotaUntil || 0)),
            pausedUntil: lane ? Number(lane.cooldownUntil || 0) : Number(state.pausedUntil || 0)
        };
    });
    return {
        candidates,
        entries,
        available: entries.filter(entry => entry.dailyUntil <= now && entry.pausedUntil <= now),
        temporarilyPaused: entries.filter(entry => entry.dailyUntil <= now && entry.pausedUntil > now),
        dailyPaused: entries.filter(entry => entry.dailyUntil > now)
    };
}

function updateGlobal429GateIfPoolExhausted(keyStates, options = {}) {
    if (!Array.isArray(keyStates) || !keyStates.length) return { allBlocked: false };
    const now = Date.now();
    const snapshot = getGeminiPoolAvailability(keyStates, now);

    // Cât timp există cel puțin un proiect eligibil, NU există pauză globală.
    if (snapshot.available.length) {
        keyStates._global429Until = 0;
        keyStates._global429LoggedUntil = 0;
        return { allBlocked: false, available: snapshot.available.length };
    }

    if (!snapshot.candidates.length) return { allBlocked: true, disabledOnly: true };

    // Dacă toate proiectele rămase au cota zilnică epuizată, selectorul va opri
    // procesarea cu eroare explicită; nu setăm o pauză scurtă care ar induce în eroare.
    if (!snapshot.temporarilyPaused.length && snapshot.dailyPaused.length === snapshot.entries.length) {
        keyStates._global429Until = 0;
        if (options.log && !keyStates._globalDailyQuotaLogged) {
            keyStates._globalDailyQuotaLogged = true;
            console.log(`${c.yellow}⚠ [Gemini Control] Toate proiectele disponibile sunt marcate cu cotă zilnică epuizată; nu mai există un proiect pentru retry până la resetarea cotei.${c.reset}`);
        }
        return { allBlocked: true, dailyOnly: true, available: 0 };
    }

    if (snapshot.temporarilyPaused.length) {
        // Toate proiectele din pool sunt în cooldown, dar nu presupunem că au
        // epuizat aceeași cotă. Reluăm la expirarea celui mai scurt cooldown și
        // serializăm proba, pentru a nu trimite mai multe cereri pe primul proiect
        // care redevine disponibil.
        const resumeAt = Math.min(...snapshot.temporarilyPaused.map(entry => entry.pausedUntil));
        const previous = Number(keyStates._global429Until || 0);
        keyStates._global429Until = resumeAt;
        const previousLimit = geminiRequestControl.maxConcurrent;
        if (geminiRequestControl.maxConcurrent > 1) {
            geminiRequestControl.maxConcurrent = 1;
            geminiRequestControl.successesSinceThrottle = 0;
        }
        if (options.log && (Math.abs(previous - resumeAt) > 1000 || !keyStates._global429LoggedUntil || previousLimit > 1)) {
            keyStates._global429LoggedUntil = resumeAt;
            console.log(`${c.yellow}⏸ [Gemini Control] Toate proiectele din pool sunt temporar indisponibile; următoarea probă după ce primul proiect devine disponibil (aprox. ${Math.max(1, Math.ceil((resumeAt - now) / 1000))}s). Concurența ${previousLimit}→${geminiRequestControl.maxConcurrent}/${geminiRequestControl.targetConcurrent}; crește după 3 succese.${c.reset}`);
        }
        notifyGeminiRequestWaiters();
        return { allBlocked: true, resumeAt, available: 0 };
    }

    return { allBlocked: true, available: 0 };
}

function detectAndApplyGlobal429Wave(lane, quotaKind = 'unknown', requestStartedAt = 0, now = Date.now(), projectPoolSize = 10, cooldownMs = 0) {
    // Cotele zilnice se rezolvă la resetare, nu printr-o pauză comună temporară.
    if (!lane || quotaKind === 'daily') return { triggered: false, reason: 'not-transient' };

    const control = geminiRequestControl;
    const previousTriggerAt = Number(control.global429LastTriggerAt || 0);
    const explicitSharedLimit = quotaKind === 'shared';

    // Păstrăm numai o fereastră de diagnostic pentru erorile per-proiect.
    // Chiar dacă multe proiecte răspund 429 aproape simultan, NU aplicăm automat
    // o pauză globală: fiecare proiect are cooldown-ul său, iar când toate sunt
    // indisponibile, poarta pool-ului așteaptă până la primul proiect eligibil.
    const events = control.recent429Projects;
    for (const [fingerprint, timestamp] of events) {
        if (now - timestamp >= 5000) events.delete(fingerprint);
    }
    events.set(lane.fingerprint, now);
    if (!explicitSharedLimit) {
        return {
            triggered: false,
            reason: 'project-level-cooldown',
            distinctProjects: events.size,
            requiredProjects: Math.max(1, Number(projectPoolSize) || 1)
        };
    }

    // O limită comună se aplică global numai dacă mesajul/detaliile Google o indică
    // explicit. Ignorăm răspunsurile întârziate ale cererilor începute înaintea
    // ultimului val, ca să nu repornim/escaladăm cooldown-ul artificial.
    if (now < Number(control.global429PauseUntil || 0)) {
        return { triggered: false, reason: 'pause-active' };
    }
    if (previousTriggerAt && Number(requestStartedAt || 0) > 0 && Number(requestStartedAt) <= previousTriggerAt) {
        return { triggered: false, reason: 'request-started-before-last-wave' };
    }

    // După 10 minute fără o nouă limită comună, pornim din nou de la treapta inițială.
    if (control.global429LastWaveAt && now - control.global429LastWaveAt >= 10 * 60 * 1000) {
        control.global429WaveCount = 0;
    }

    const waveNumber = Number(control.global429WaveCount || 0) + 1;
    const baseCooldownMs = Math.max(1000, Number(cooldownMs) || 15000);
    // Respectăm Retry-After/RetryInfo cel puțin; dacă aceeași limită comună se repetă,
    // creștem exponențial intervalul până la 60s, cu jitter pentru a evita rafale sincronizate.
    const pauseMs = Math.min(60000, baseCooldownMs * Math.pow(2, Math.min(6, waveNumber - 1)))
        + Math.floor(Math.random() * 501);
    const previousLimit = control.maxConcurrent;
    const pauseUntil = now + pauseMs;
    control.global429WaveCount = waveNumber;
    control.global429LastWaveAt = now;
    control.global429LastTriggerAt = now;
    control.global429PauseUntil = pauseUntil;
    control.cooldownUntil = Math.max(Number(control.cooldownUntil || 0), pauseUntil);
    control.maxConcurrent = 1;
    control.successesSinceThrottle = 0;
    control.recent429Projects.clear();

    notifyGeminiRequestWaiters();
    return { triggered: true, waveNumber, pauseMs, pauseUntil, previousLimit, currentLimit: control.maxConcurrent, explicitSharedLimit };
}

function registerGlobalGemini429(cooldownMs, quotaKind = 'unknown', keyState = null, requestStartedAt = 0) {
    const now = Date.now();
    const pauseMs = Math.max(1000, Number(cooldownMs) || 15000);
    geminiRequestControl.nextStartAt = Math.max(
        Number(geminiRequestControl.nextStartAt || 0),
        now + GEMINI_429_INTER_REQUEST_PAUSE_MS
    );
    const lane = getLaneForKeyState(keyState);
    geminiRequestControl.consecutive429++;
    geminiRequestControl.consecutive5xx = 0;
    geminiRequestControl.successesSinceThrottle = 0;

    if (lane) {
        lane.last429At = now;
        lane.lastTouchedAt = now;
        lane.consecutive429++;
        if (quotaKind === 'daily') {
            const resetAt = Math.max(Number(lane.dailyQuotaUntil || 0), Number(keyState?.dailyQuotaUntil || 0), getNextPacificMidnightMs(now));
            lane.dailyQuotaUntil = resetAt;
            lane.cooldownUntil = 0;
            if (keyState) {
                keyState.dailyQuotaUntil = Math.max(Number(keyState.dailyQuotaUntil || 0), resetAt);
                keyState.pausedUntil = 0;
            }
        } else {
            lane.cooldownUntil = Math.max(Number(lane.cooldownUntil || 0), now + pauseMs);
            if (keyState) keyState.pausedUntil = Math.max(Number(keyState.pausedUntil || 0), lane.cooldownUntil);
        }
    }

    const pool = keyState?._keyPool;
    if (pool && lane) {
        if (!(pool._429WaveFailedProjects instanceof Set)) pool._429WaveFailedProjects = new Set();
        pool._429WaveFailedProjects.add(lane.fingerprint);
    }
    const activeProjectCount = Array.isArray(pool)
        ? pool.filter(state => !state.disabled && !getLaneForKeyState(state)?.disabled).length
        : 1;
    // Un proiect limitat nu blochează celelalte proiecte. Pauza comună este
    // rezervată unei limite comune identificate explicit în răspunsul Google.
    const globalWave = detectAndApplyGlobal429Wave(lane, quotaKind, requestStartedAt, now, activeProjectCount, pauseMs);
    const poolStatus = updateGlobal429GateIfPoolExhausted(pool, { log: false });
    const projectIndex = Array.isArray(pool) ? pool.indexOf(keyState) : -1;
    const projectLabel = lane
        ? `${projectIndex >= 0 ? `${projectIndex + 1}/${pool.length} ` : ''}[${lane.fingerprint.slice(0, 8)}]`
        : 'necunoscut';
    let waveExhausted = false;
    if (Array.isArray(pool)) {
        const activeProjects = new Set(pool.filter(state => {
            const currentLane = getLaneForKeyState(state);
            return !state.disabled && !currentLane.disabled;
        }).map(state => getLaneForKeyState(state)?.fingerprint).filter(Boolean));
        if (activeProjects.size && pool._429WaveFailedProjects.size >= activeProjects.size && !pool._429WaveExhaustionLogged) {
            pool._429WaveExhaustionLogged = true;
            waveExhausted = true;
        }
    }
    notifyGeminiRequestWaiters();
    return { poolStatus, globalWave, projectLabel, waveExhausted, pauseMs };
}

function registerGlobalGemini5xx(status) {
    const now = Date.now();
    geminiRequestControl.consecutive5xx++;
    geminiRequestControl.consecutive429 = 0;
    geminiRequestControl.maxConcurrent = Math.max(1, geminiRequestControl.maxConcurrent - 1);
    geminiRequestControl.successesSinceThrottle = 0;
    const backoffBaseMs = Math.min(30000, 2000 * Math.pow(2, geminiRequestControl.consecutive5xx - 1));
    const jitterMs = Math.floor(Math.random() * Math.min(1500, Math.max(250, backoffBaseMs * 0.25)));
    const pauseMs = backoffBaseMs + jitterMs;
    geminiRequestControl.cooldownUntil = Math.max(geminiRequestControl.cooldownUntil, now + pauseMs);
    console.log(`${c.yellow}⚠ Gemini ${status} | Pauză ${Math.ceil(pauseMs / 1000)}s | Concurență ${geminiRequestControl.maxConcurrent}/${geminiRequestControl.targetConcurrent}${c.reset}`);
    notifyGeminiRequestWaiters();
}

function getNextPacificMidnightMs(nowMs = Date.now()) {
    const timeZone = 'America/Los_Angeles';
    const partsFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    });
    const dateParts = partsFormatter.formatToParts(new Date(nowMs));
    const pick = type => Number(dateParts.find(part => part.type === type)?.value);
    const tomorrowUtcDate = new Date(Date.UTC(pick('year'), pick('month') - 1, pick('day') + 1));
    const targetYear = tomorrowUtcDate.getUTCFullYear();
    const targetMonth = tomorrowUtcDate.getUTCMonth() + 1;
    const targetDay = tomorrowUtcDate.getUTCDate();
    const targetWallTime = Date.UTC(targetYear, targetMonth - 1, targetDay, 0, 0, 0);
    let guess = targetWallTime;

    // Conversie iterativă a miezului nopții din Los Angeles în UTC, inclusiv DST.
    for (let i = 0; i < 4; i++) {
        const localParts = partsFormatter.formatToParts(new Date(guess));
        const get = type => Number(localParts.find(part => part.type === type)?.value);
        const observedAsUtc = Date.UTC(
            get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')
        );
        guess += targetWallTime - observedAsUtc;
    }
    return Math.max(nowMs + 60000, guess);
}

function classifyGeminiQuotaError(error) {
    const responseData = error?.response?.data || {};
    const providerError = responseData.error || {};
    const message = String(providerError.message || responseData.message || '').replace(/\s+/g, ' ').trim();
    const details = Array.isArray(providerError.details) ? providerError.details : [];
    const detailsText = details.map(detail => {
        if (!detail || typeof detail !== 'object') return String(detail || '');
        const pieces = [
            detail['@type'] ? `type=${detail['@type']}` : '',
            detail.quotaMetric ? `quotaMetric=${detail.quotaMetric}` : '',
            detail.quotaId ? `quotaId=${detail.quotaId}` : '',
            detail.quotaValue ? `quotaValue=${detail.quotaValue}` : '',
            detail.limit ? `limit=${detail.limit}` : '',
            detail.reason ? `reason=${detail.reason}` : '',
            detail.retryDelay ? `retryDelay=${detail.retryDelay}` : '',
            detail.subject ? `subject=${detail.subject}` : '',
            detail.description ? `description=${detail.description}` : ''
        ];
        if (Array.isArray(detail.violations)) {
            for (const violation of detail.violations) {
                if (!violation || typeof violation !== 'object') continue;
                pieces.push([
                    violation.quotaMetric ? `quotaMetric=${violation.quotaMetric}` : '',
                    violation.quotaId ? `quotaId=${violation.quotaId}` : '',
                    violation.subject ? `subject=${violation.subject}` : '',
                    violation.description ? `description=${violation.description}` : ''
                ].filter(Boolean).join(' '));
            }
        }
        if (detail.metadata && typeof detail.metadata === 'object') {
            const metadata = Object.entries(detail.metadata)
                .filter(([key, value]) => /quota|metric|limit|retry|reason|resource|model/i.test(key) && value != null)
                .map(([key, value]) => `${key}=${String(value).slice(0, 120)}`);
            pieces.push(...metadata);
        }
        return pieces.filter(Boolean).join(' ');
    }).join(' | ');
    const combined = `${message} ${detailsText}`;
    let kind = 'unknown';
    if (/(?:requests?|tokens?|generatecontent).{0,40}(?:per.?day|perday)|(?:per.?day).{0,30}(?:quota|project|model)|daily\s+quota|RequestsPerDay|TokensPerDay/i.test(combined)) {
        kind = 'daily';
    } else if (/(?:spend[- ]based|billing\s+account.{0,80}(?:spend|rate.?limit|quota|limit)|(?:shared|account[- ]level|billing[- ]account).{0,40}(?:quota|limit|exhausted|resource.?exhausted))/i.test(combined)) {
        // Unele limite de cheltuieli sunt evaluate la nivelul contului de billing,
        // chiar dacă apelul a folosit un alt proiect. Le tratăm explicit ca limită comună.
        kind = 'shared';
    } else if (/(?:per.?minute|per.?second|requestsperminute|tokensperminute|\bRPM\b|\bTPM\b|rate.?limit|too many requests|RequestsPerMinute|TokensPerMinute)/i.test(combined)) {
        kind = 'rate';
    }
    const diagnosticDetail = detailsText.replace(/\s+/g, ' ').trim().slice(0, 500);
    return {
        kind,
        message: message.slice(0, 300),
        detailsText: diagnosticDetail,
        providerStatus: String(providerError.status || responseData.status || '').slice(0, 80),
        providerCode: providerError.code ?? responseData.code ?? error?.response?.status ?? null,
        responseDataKeys: Object.keys(responseData).slice(0, 12).join(',')
    };
}

function parseRetryAfterMs(retryAfterHeader, fallbackMs = 30000) {
    const now = Date.now();
    const raw = String(retryAfterHeader ?? '').trim();
    if (raw) {
        const seconds = Number(raw);
        if (Number.isFinite(seconds) && seconds >= 0) {
            return Math.max(1000, Math.ceil(seconds * 1000));
        }

        // Retry-After poate fi fie număr de secunde, fie dată HTTP.
        const retryAt = Date.parse(raw);
        if (Number.isFinite(retryAt) && retryAt > now) {
            return Math.max(1000, retryAt - now);
        }
    }
    return fallbackMs == null ? null : Math.max(1000, Number(fallbackMs) || 30000);
}

function extractGeminiRetryDelayMs(error, fallbackMs) {
    const headers = error?.response?.headers || {};
    const fromHeader = parseRetryAfterMs(headers['retry-after'] ?? headers['Retry-After'], null);
    if (fromHeader != null) return fromHeader;

    const details = error?.response?.data?.error?.details;
    if (Array.isArray(details)) {
        for (const detail of details) {
            const retryDelay = String(detail?.retryDelay || '').trim();
            const match = retryDelay.match(/^(\d+(?:\.\d+)?)s$/i);
            if (match) return Math.max(1000, Math.ceil(Number(match[1]) * 1000));
        }
    }
    return fallbackMs;
}

// Selector global pentru proiectele Gemini folosite în acest proces Node.
// Conform configurării addon-ului, fiecare cheie distinctă trebuie să provină
// dintr-un proiect Google Cloud distinct. Amprentarea SHA-256 permite coordonarea
// fără păstrarea cheii API ca identificator și fără afișarea ei în loguri.
const geminiProjectLanes = new Map();
const GEMINI_RECENT_REQUEST_WINDOW_MS = 60_000;

function getGeminiProjectLane(apiKey) {
    const fingerprint = crypto.createHash('sha256').update(String(apiKey)).digest('hex');
    const now = Date.now();
    let lane = geminiProjectLanes.get(fingerprint);
    if (!lane) {
        lane = {
            fingerprint,
            lastSelectedAt: 0,
            lastRequestAt: 0,
            recentRequestStarts: [],
            activeRequests: 0,
            reservations: 0,
            selections: 0,
            cooldownUntil: 0,
            dailyQuotaUntil: 0,
            disabled: false,
            consecutive429: 0,
            last429At: 0,
            lastTouchedAt: now
        };
        geminiProjectLanes.set(fingerprint, lane);
    }
    lane.lastTouchedAt = now;

    // Limitează creșterea memoriei dacă instanța primește configurații foarte
    // multe și diferite. Nu eliminăm niciodată o bandă activă, rezervată sau blocată.
    if (geminiProjectLanes.size > 2000) {
        const staleBefore = now - 6 * 60 * 60 * 1000;
        for (const [id, candidate] of geminiProjectLanes) {
            if (geminiProjectLanes.size <= 1500) break;
            if (
                candidate.activeRequests === 0 &&
                candidate.reservations === 0 &&
                candidate.cooldownUntil <= now &&
                candidate.dailyQuotaUntil <= now &&
                candidate.lastTouchedAt < staleBefore
            ) {
                geminiProjectLanes.delete(id);
            }
        }
    }
    return lane;
}

function getLaneForKeyState(keyState) {
    if (!keyState) return null;
    if (!keyState.globalLane) keyState.globalLane = getGeminiProjectLane(keyState.key);
    keyState.globalLane.lastTouchedAt = Date.now();
    return keyState.globalLane;
}

function consumeGlobalKeyReservation(keyState) {
    const lane = getLaneForKeyState(keyState);
    if (!lane || Number(keyState._pendingGlobalReservations || 0) <= 0) return false;
    keyState._pendingGlobalReservations--;
    lane.reservations = Math.max(0, lane.reservations - 1);
    lane.lastTouchedAt = Date.now();
    return true;
}

function getRecentProjectRequestCount(lane, now) {
    lane.recentRequestStarts = (lane.recentRequestStarts || [])
        .filter(timestamp => now - timestamp < GEMINI_RECENT_REQUEST_WINDOW_MS);
    return lane.recentRequestStarts.length;
}

function createKeyState(keys) {
    const states = keys.map(key => ({
        key,
        pausedUntil: 0,
        dailyQuotaUntil: 0,
        disabled: false,
        failures: 0,
        lastUsed: 0,
        globalLane: getGeminiProjectLane(key),
        _pendingGlobalReservations: 0
    }));
    // Asociere internă (nu conține valori noi în payload-uri/loguri): permite
    // fiecărei erori 429 să determine dacă mai există proiecte disponibile.
    for (const state of states) state._keyPool = states;
    return states;
}

function getGlobal429Until(keyStates) { return Number(keyStates._global429Until || 0); }

function register429(keyStates, cooldownMs, forceGlobal = false) {
    // 429-ul este înregistrat în callGemini pe banda proiectului exact care l-a
    // primit. Nu punem întreaga subtitrare în pauză: celelalte proiecte trebuie
    // să poată prelua cererile rămase. Păstrăm funcția drept wrapper pentru
    // apelurile existente din Grammar Review/recuperare.
    return false;
}

async function waitFor429Gate(keyStates) {
    while (true) {
        const waitMs = getGlobal429Until(keyStates) - Date.now();
        if (waitMs <= 0) return;
        // Recheck cel puțin o dată pe secundă: o cerere activă poate reuși între timp
        // și elibera un proiect, caz în care nu mai trebuie așteptată vechea poartă.
        await waitForGeminiRequestChange(Math.min(waitMs, 1000));
    }
}

function getMaximumTransientPoolCooldownMs(keyStates, now = Date.now(), includeAvailableProjects = false) {
    const snapshot = getGeminiPoolAvailability(keyStates, now);
    if (snapshot.available.length && !includeAvailableProjects) return 0;
    const transient = snapshot.entries.filter(entry =>
        !entry.state.disabled && !entry.lane?.disabled && entry.dailyUntil <= now && entry.pausedUntil > now
    );
    if (!transient.length) return 0;
    return Math.max(...transient.map(entry => Math.max(0, entry.pausedUntil - now)));
}

function getMinimumTransientPoolCooldownMs(keyStates, now = Date.now(), includeAvailableProjects = false) {
    const snapshot = getGeminiPoolAvailability(keyStates, now);
    if (snapshot.available.length && !includeAvailableProjects) return 0;
    const transient = snapshot.entries.filter(entry =>
        !entry.state.disabled && !entry.lane?.disabled && entry.dailyUntil <= now && entry.pausedUntil > now
    );
    if (!transient.length) return 0;
    return Math.max(0, Math.min(...transient.map(entry => entry.pausedUntil - now)));
}

function tripPrimary429Circuit(keyStates, reason) {
    if (!keyStates._primary429CircuitOpen) {
        keyStates._primary429CircuitOpen = true;
        keyStates._secondaryRecovery429Hold = true;
        keyStates._emptyRecoveryIndividualRetriesDisabled = true;
        keyStates._primary429CircuitReason = String(reason || '429 repetat pe traducerea principală');
        console.log(`${c.yellow}[Gemini Control] Circuit de protecție activat: ${keyStates._primary429CircuitReason}. Oprim cererile AI suplimentare; păstrăm traducerile existente și raportăm ID-urile nerezolvate.${c.reset}`);
    }
}

async function getAvailableKey(keyStates, options = {}) {
    const excludedStates = options.excludeStates instanceof Set ? options.excludeStates : null;
    // Un 429 pune proiectul în cooldown temporar; nu îl blocăm pentru tot SRT-ul.
    // excludeStates împiedică aceeași cerere să reîncerce același proiect în rotația curentă.
    const failFastIfNoAvailable = options.failFastIfNoAvailable === true;
    while (true) {
        // În rotația 429, nu așteptăm ca un proiect deja limitat să redevină
        // eligibil înainte să încercăm proiectele disponibile. Pentru o probă
        // amânată, apelantul poate permite așteptarea primei chei eliberate.
        if (!failFastIfNoAvailable) await waitFor429Gate(keyStates);
        const now = Date.now();
        const nonDisabled = keyStates.filter(state => {
            const lane = getLaneForKeyState(state);
            return !state.disabled && !lane.disabled &&
                !(excludedStates && excludedStates.has(state));
        });
        const statusFor = state => {
            const lane = getLaneForKeyState(state);
            return {
                lane,
                dailyUntil: Math.max(Number(state.dailyQuotaUntil || 0), Number(lane.dailyQuotaUntil || 0)),
                pausedUntil: lane ? Number(lane.cooldownUntil || 0) : Number(state.pausedUntil || 0)
            };
        };

        const available = nonDisabled
            .map(state => ({ state, ...statusFor(state) }))
            .filter(entry => entry.dailyUntil <= now && entry.pausedUntil <= now)
            .sort((a, b) => {
                // Mai întâi proiectele mai puțin solicitate simultan, apoi cele
                // cu mai puține cereri în ultimul minut și, la egalitate, cele
                // folosite cel mai demult. Rezervările împiedică procesările
                // concurente să aleagă toate aceeași cheie înainte de start.
                const aLoad = a.lane.activeRequests + a.lane.reservations;
                const bLoad = b.lane.activeRequests + b.lane.reservations;
                if (aLoad !== bLoad) return aLoad - bLoad;
                const aRecent = getRecentProjectRequestCount(a.lane, now);
                const bRecent = getRecentProjectRequestCount(b.lane, now);
                if (aRecent !== bRecent) return aRecent - bRecent;
                if (a.lane.lastSelectedAt !== b.lane.lastSelectedAt) {
                    return a.lane.lastSelectedAt - b.lane.lastSelectedAt;
                }
                return a.lane.selections - b.lane.selections;
            });

        if (available.length) {
            const selected = available[0].state;
            const lane = getLaneForKeyState(selected);
            lane.reservations++;
            lane.selections++;
            lane.lastSelectedAt = now;
            lane.lastTouchedAt = now;
            selected._pendingGlobalReservations = Number(selected._pendingGlobalReservations || 0) + 1;
            selected.lastUsed = now;
            // Sincronizăm starea locală cu pauza globală a acestei chei/proiect.
            selected.pausedUntil = Number(lane.cooldownUntil || 0);
            selected.dailyQuotaUntil = Math.max(Number(selected.dailyQuotaUntil || 0), lane.dailyQuotaUntil);
            return selected;
        }

        // Dacă o rotație în modul de așteptare a încercat deja toate proiectele,
        // raportăm epuizarea rotației ca 429 controlat, nu ca eroare generică ce ar
        // declanșa split-ul calupului. Apelantul de recuperare va aștepta/resetă tura.
        if (failFastIfNoAvailable || (excludedStates instanceof Set && excludedStates.size > 0 && nonDisabled.length === 0)) {
            const error = new Error('429: Nu mai există proiecte Gemini neîncercate și eligibile momentan pentru această cerere.');
            error.isRateLimit429 = true;
            error.isPoolRotationExhausted = true;
            const nextTransient = nonDisabled
                .map(state => {
                    const lane = getLaneForKeyState(state);
                    return Math.max(Number(state.pausedUntil || 0), Number(lane?.cooldownUntil || 0));
                })
                .filter(until => until > now);
            if (nextTransient.length) error.retryAfterMs = Math.max(1000, Math.min(...nextTransient) - now);
            throw error;
        }

        const dailyBlocked = nonDisabled
            .map(state => ({ state, ...statusFor(state) }))
            .filter(entry => entry.dailyUntil > now);
        if (nonDisabled.length > 0 && dailyBlocked.length === nonDisabled.length) {
            const nextReset = Math.min(...dailyBlocked.map(entry => entry.dailyUntil));
            const error = new Error(`429: Cota zilnică Gemini este epuizată pentru toate proiectele disponibile; următoarea resetare estimată este ${new Date(nextReset).toISOString()}. Oprire fără reîncercări inutile.`);
            error.isRateLimit429 = true;
            error.isDailyQuota429 = true;
            error.isPermanentQuotaBlock = true;
            throw error;
        }

        const waitingEntries = nonDisabled
            .map(state => ({ state, ...statusFor(state) }))
            .filter(entry => entry.dailyUntil <= now && entry.pausedUntil > now);

        if (!waitingEntries.length) {
            throw new Error('Toate proiectele Gemini configurate sunt dezactivate sau blocate de cotă.');
        }

        // Pauza globală este justificată numai după ce NU mai există niciun
        // proiect eligibil în pool. O singură cheie limitată nu oprește celelalte.
        updateGlobal429GateIfPoolExhausted(keyStates, { log: false });
        const nextAvailableAt = Math.min(...waitingEntries.map(entry => entry.pausedUntil));
        keyStates._global429Until = nextAvailableAt;
        await waitFor429Gate(keyStates);
    }
}

async function callGeminiWithKeyRotationUnlocked(prompt, keyStates, options = {}) {
    // Recuperările auxiliare (replici lipsă, corecturi punctuale) au o rotație
    // limitată prin proiectele eligibile. Retry-ul extins după cooldown aparține
    // cozii coordonate a calupurilor, ca să nu multiplicăm fiecare cerere auxiliară.
    const allowAfter429Hold = options.allowAfter429Hold === true;
    let finalRecoveryProbe = false;
    if (keyStates._secondaryRecovery429Hold) {
        if (!allowAfter429Hold || keyStates._finalRecoveryAfter429Attempted) {
            const blockedError = new Error('429: pool-ul Gemini a fost epuizat în recuperările anterioare; nu se pornesc alte cereri auxiliare.');
            blockedError.isRateLimit429 = true;
            blockedError.isSecondaryRecoveryBlocked = true;
            throw blockedError;
        }
        keyStates._finalRecoveryAfter429Attempted = true;
        finalRecoveryProbe = true;
    } else if (allowAfter429Hold) {
        if (keyStates._finalRecoveryAfter429Attempted) {
            const blockedError = new Error('429: proba agregată finală a fost deja folosită; nu se pornesc alte cereri auxiliare.');
            blockedError.isRateLimit429 = true;
            blockedError.isSecondaryRecoveryBlocked = true;
            throw blockedError;
        }
        keyStates._finalRecoveryAfter429Attempted = true;
        finalRecoveryProbe = true;
    }

    // După circuitul 429, proba agregată finală înseamnă cel mult un apel API,
    // nu o nouă rotație completă prin cele zece proiecte.
    const maxKeyAttempts = finalRecoveryProbe
        ? 1
        : Math.max(1, Array.isArray(keyStates) ? keyStates.length : 1);
    const maxTransientAttempts = 8;
    const maxFast429Attempts = 2;
    const attemptedKeyStates = new Set();
    let rateLimitAttempts = 0;
    let fiveXxAttempts = 0;
    let lastError = null;

    for (let attempt = 1; attempt <= maxKeyAttempts; attempt++) {
        let keyState = null;
        try {
            if (keyStates._secondaryRecovery429Hold && !finalRecoveryProbe) {
                const blockedError = new Error('429: altă cerere auxiliară a epuizat deja pool-ul; opresc această recuperare paralelă.');
                blockedError.isRateLimit429 = true;
                blockedError.isSecondaryRecoveryBlocked = true;
                throw blockedError;
            }
            // Pentru 429 încercăm proiecte distincte și nu reîncercăm imediat
            // un proiect deja marcat în cooldown. Pool-ul și benzile de proiect
            // sunt comune tuturor calupurilor din acest proces Node.
            keyState = await getAvailableKey(keyStates, {
                excludeStates: attemptedKeyStates,
                failFastIfNoAvailable: true
            });
            attemptedKeyStates.add(keyState);
            return await callGemini(prompt, keyState, options);
        } catch (error) {
            lastError = error;
            if (error?.isGlobalWaveDeferral === true) throw error;

            const message = String(error?.message || error);
            const is429 = error?.isRateLimit429 === true || /\b429\b/i.test(message);
            const status = Number(error?.response?.status || 0);
            const is5xx = (status >= 500 && status <= 599) || /status code 5\d\d/i.test(message);

            if (is429) {
                rateLimitAttempts++;
                if (markEmptyRecoveryQuotaBlock(keyStates, error)) throw error;
                if (error?.isPoolRotationExhausted || rateLimitAttempts >= maxFast429Attempts || attemptedKeyStates.size >= maxKeyAttempts || attempt >= maxKeyAttempts) {
                    keyStates._secondaryRecovery429Hold = true;
                    keyStates._emptyRecoveryIndividualRetriesDisabled = true;
                    throw error;
                }
                await sleep(GEMINI_429_INTER_REQUEST_PAUSE_MS + Math.floor(Math.random() * 501));
                continue;
            }

            if (is5xx) {
                fiveXxAttempts++;
                if (fiveXxAttempts < maxTransientAttempts && attempt < maxKeyAttempts) {
                    // callGemini a înregistrat backoff-ul global. Eliberăm rotația
                    // locală: 503 este o problemă de serviciu, nu dovada că proiectul
                    // API curent are o cotă diferită de celelalte.
                    attemptedKeyStates.clear();
                    console.log(`${c.yellow}↻ Recovery ${status || message.match(/5\d\d/)?.[0] || '5xx'} | Retry ${fiveXxAttempts}/${maxTransientAttempts} | Backoff activ${c.reset}`);
                    continue;
                }
                console.log(`${c.red}[Gemini Recovery] Bugetul retry 5xx s-a epuizat (${fiveXxAttempts}/${maxTransientAttempts}).${c.reset}`);
                throw error;
            }

            throw error;
        }
    }

    throw lastError || new Error('Recuperarea Gemini a eșuat fără un răspuns.');
}

// Recuperările auxiliare folosesc o singură coadă pe pool. Fără acest mutex,
// trei verificări AI simultane puteau fiecare să rotească zece proiecte și să
// molesteze același pool cu aproape 30 de cereri după ce primele 429 sosiseră.
async function callGeminiWithKeyRotation(prompt, keyStates, options = {}) {
    // Recuperările auxiliare folosesc o singură coadă globală per pool. Fără
    // acest mutex, mai multe calupuri ar putea porni simultan rotații separate
    // și ar consuma proiectele înainte ca primul val 429 să fie observat complet.
    const previous = keyStates._auxiliaryRecoveryQueue || Promise.resolve();
    let releaseQueue;
    const token = new Promise(resolve => { releaseQueue = resolve; });
    const queued = previous.catch(() => {}).then(() => token);
    keyStates._auxiliaryRecoveryQueue = queued;
    await previous.catch(() => {});
    try {
        return await callGeminiWithKeyRotationUnlocked(prompt, keyStates, options);
    } finally {
        releaseQueue();
        if (keyStates._auxiliaryRecoveryQueue === queued) {
            keyStates._auxiliaryRecoveryQueue = Promise.resolve();
        }
    }
}

function createGlobal429DeferralError() {
    const now = Date.now();
    const pauseUntil = Number(geminiRequestControl.global429PauseUntil || 0);
    const retryAfterMs = Math.max(1000, pauseUntil - now);
    const error = new Error(`429: cererea a fost amânată în timpul pauzei globale Gemini (${Math.ceil(retryAfterMs / 1000)}s); nu a fost trimis un apel API nou.`);
    error.isRateLimit429 = true;
    error.isPoolRotationExhausted = true;
    error.isGlobalWaveDeferral = true;
    error.retryAfterMs = retryAfterMs;
    return error;
}

function getRequestStartIntervalMs(requestLabel) {
    const match = String(requestLabel || '').match(/\bcalup\s+(\d+)/i);
    const chunkNumber = match ? Number(match[1]) : 0;
    return chunkNumber >= GEMINI_LATER_CHUNK_PACING_START_CHUNK
        ? GEMINI_LATER_CHUNK_START_INTERVAL_MS
        : GEMINI_DEFAULT_REQUEST_START_INTERVAL_MS;
}

async function callGemini(prompt, keyState, options = {}) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent`;
    const timeout = Number.isInteger(options.timeout) ? options.timeout : 120000;
    const responseSchema = options.responseSchema || {
        type: 'ARRAY',
        minItems: 1,
        items: {
            type: 'OBJECT',
            properties: {
                id: { type: 'INTEGER' },
                text: { type: 'STRING' }
            },
            required: ['id', 'text'],
            propertyOrdering: ['id', 'text']
        }
    };

    // RO Sub Translator folosește nivelul de gândire MEDIUM pentru traduceri mai atente.
    // Gemini 3.5 Flash-Lite îl suportă; parametrul temperature este omis deoarece
    // documentația Gemini 3.5 îl marchează drept depreciat/ignorat pentru aceste modele.
    // Fallback-ul plainText este folosit numai când Grammar Review returnează
    // JSON invalid chiar și pentru o singură replică. Toate cererile obișnuite
    // păstrează schema JSON existentă.
    const generationConfig = options.plainText
        ? {}
        : {
            responseMimeType: 'application/json',
            responseSchema
        };
    // Nivelul implicit este MEDIUM pentru traducere și verificările auxiliare.
    // O etapă poate supraregla nivelul prin options.thinkingLevel când este necesar.
    const thinkingLevel = Object.prototype.hasOwnProperty.call(options, 'thinkingLevel')
        ? options.thinkingLevel
        : 'MEDIUM';
    if (/^gemini-3(?:\.|-)/i.test(String(MODEL_NAME)) && typeof thinkingLevel === 'string' && thinkingLevel) {
        generationConfig.thinkingConfig = { thinkingLevel };
    }

    // Permisul este la nivelul procesului, nu al unei singure subtitrări.
    // Fiecare cheie are și o bandă globală de proiect: active, rezervări,
    // frecvență recentă și pauză după 429. Cheia nu este logată sau păstrată
    // ca identificator în selector.
    let releaseGeminiSlot = null;
    let lane = getLaneForKeyState(keyState);
    let laneRequestStarted = false;
    let laneRequestStartedAt = 0;
    const global429WaveAtCallStart = Number(geminiRequestControl.global429LastTriggerAt || 0);
    try {
        // Dacă pauza globală este deja activă, amânăm calupul în coada de recuperare;
        // nu îl lăsăm să aștepte la poartă și apoi să lovească API-ul la expirarea pauzei.
        if (Date.now() < Number(geminiRequestControl.global429PauseUntil || 0)) {
            throw createGlobal429DeferralError();
        }
        releaseGeminiSlot = await acquireGeminiRequestSlot(getRequestStartIntervalMs(options.requestLabel));
        // Un val poate începe cât timp cererea așteaptă un slot. În acel caz nu trimitem
        // apelul preselectat după cooldown; lăsăm coada să facă o singură probă controlată.
        if (Number(geminiRequestControl.global429LastTriggerAt || 0) > global429WaveAtCallStart) {
            throw createGlobal429DeferralError();
        }
        lane = getLaneForKeyState(keyState);
        const preflightNow = Date.now();
        const laneDailyUntil = lane ? Number(lane.dailyQuotaUntil || 0) : Number(keyState.dailyQuotaUntil || 0);
        const laneCooldownUntil = lane ? Number(lane.cooldownUntil || 0) : Number(keyState.pausedUntil || 0);
        if (keyState.disabled || lane?.disabled || laneDailyUntil > preflightNow || laneCooldownUntil > preflightNow) {
            const blockedUntil = laneDailyUntil > preflightNow ? laneDailyUntil : laneCooldownUntil;
            const error = new Error(
                laneDailyUntil > preflightNow
                    ? '429: Proiectul selectat a fost marcat între timp cu o cotă zilnică epuizată; selectorul va alege alt proiect.'
                    : '429: Proiectul selectat a intrat în pauză înainte de pornirea cererii; selectorul va alege alt proiect.'
            );
            error.isRateLimit429 = true;
            error.isProjectQuota429 = true;
            error.isDailyQuota429 = laneDailyUntil > preflightNow;
            error.retryAfterMs = Math.max(1000, blockedUntil - preflightNow);
            throw error;
        }
        consumeGlobalKeyReservation(keyState);
        if (lane) {
            lane.activeRequests++;
            laneRequestStartedAt = Date.now();
            lane.lastRequestAt = laneRequestStartedAt;
            lane.lastTouchedAt = lane.lastRequestAt;
            lane.recentRequestStarts.push(lane.lastRequestAt);
            getRecentProjectRequestCount(lane, lane.lastRequestAt);
            laneRequestStarted = true;
        }
        const response = await axios.post(
            endpoint,
            {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig,
                safetySettings: [
                    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
                ]
            },
            {
                timeout,
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': keyState.key
                }
            }
        );

        const raw = response.data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
        if (!raw.trim()) throw new Error('Gemini a returnat conținut gol.');
        keyState.failures = 0;
        noteGeminiRequestSuccess(keyState);
        return raw;
    } catch (error) {
        const status = error.response?.status;
        if (status === 401 || status === 403) {
            keyState.disabled = true;
            const invalidLane = getLaneForKeyState(keyState);
            if (invalidLane) invalidLane.disabled = true;
            throw new Error(`Cheie Gemini invalidă (${status}).`);
        }
        if (status === 400) {
            const providerError = error.response?.data?.error || {};
            const providerMessage = String(providerError.message || error.message || 'detalii indisponibile')
                .replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
            const providerDetails = providerError.details == null
                ? ''
                : ` | detalii API: ${JSON.stringify(providerError.details).replace(/[\r\n\t]+/g, ' ').slice(0, 1200)}`;
            const requestLabel = String(options.requestLabel || 'Cerere Gemini')
                .replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
            // Nu logăm request-ul, promptul sau cheia API; numai motivul de eroare returnat de Google.
            console.error(`${c.red}[Gemini 400] ${requestLabel}: ${providerMessage}${providerDetails}${c.reset}`);
        }
        if (status === 429) {
            const quotaInfo = classifyGeminiQuotaError(error);
            lane = getLaneForKeyState(keyState);
            // Backoff-ul progresiv este separat pentru fiecare proiect, nu pentru
            // întregul pool: 15, 30, 60, apoi 120s (+ jitter), dacă Google nu dă
            // Retry-After/RetryInfo explicit.
            const project429Count = Number(lane?.consecutive429 || 0);
            const fallbackCooldown = Math.min(120000, 15000 * Math.pow(2, Math.min(3, project429Count))) + Math.floor(Math.random() * 1500);
            const cooldownMs = extractGeminiRetryDelayMs(error, fallbackCooldown);
            keyState.pausedUntil = Math.max(Number(keyState.pausedUntil || 0), Date.now() + cooldownMs);
            if (quotaInfo.kind === 'daily') keyState.dailyQuotaUntil = Math.max(Number(keyState.dailyQuotaUntil || 0), getNextPacificMidnightMs());
            const registration = registerGlobalGemini429(cooldownMs, quotaInfo.kind, keyState, laneRequestStartedAt);

            const providerMessage = String(quotaInfo.message || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 260);
            const requestLabel = String(options.requestLabel || 'Cerere Gemini')
                .replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
            const projectLabel = registration?.projectLabel || (lane ? `[${lane.fingerprint.slice(0, 8)}]` : 'necunoscut');
            const projectPause = quotaInfo.kind === 'daily'
                ? `până la resetarea estimată ${new Date(keyState.dailyQuotaUntil).toISOString()}`
                : `${Math.ceil(cooldownMs / 1000)}s`;
            const poolStatus = registration?.poolStatus || {};
            const poolNote = poolStatus.dailyOnly
                ? ' Toate proiectele active sunt marcate cu cotă zilnică epuizată.'
                : poolStatus.allBlocked && poolStatus.resumeAt
                    ? ` Niciun proiect eligibil acum; următoarea probă este estimată în ${Math.max(1, Math.ceil((poolStatus.resumeAt - Date.now()) / 1000))}s.`
                    : poolStatus.available > 0
                        ? ` Alte proiecte eligibile: ${poolStatus.available}.`
                        : '';
            const sharedNote = registration?.globalWave?.triggered
                ? ` Limită comună confirmată; pauză globală ${Math.ceil(registration.globalWave.pauseMs / 1000)}s.`
                : '';
            const providerNote = providerMessage ? ` Detaliu Google: ${providerMessage}` : ' Detaliul exact al cotei nu a fost furnizat de Google.';
            const details = providerMessage ? ` Detaliu Google: ${providerMessage}` : '';
            const structuredDetails = quotaInfo.detailsText ? ` Detalii cotă: ${quotaInfo.detailsText}` : '';
            console.log(`${c.yellow}⚠ [429] ${requestLabel} — proiect ${projectLabel}; tip=${quotaInfo.kind}; pauză proiect ${projectPause}; următoarea cerere Gemini nu pornește timp de minimum ${Math.ceil(GEMINI_429_INTER_REQUEST_PAUSE_MS / 1000)}s.${poolNote}${sharedNote}${providerNote}${c.reset}`);

            const retryError = new Error(`Limită Gemini 429; pauză ${Math.ceil(cooldownMs / 1000)}s.${details}${structuredDetails}`);
            retryError.isRateLimit429 = true;
            retryError.isProjectQuota429 = /resource has been exhausted|quota/i.test(providerMessage);
            retryError.isDailyQuota429 = quotaInfo.kind === 'daily';
            retryError.quotaKind = quotaInfo.kind;
            retryError.retryAfterMs = cooldownMs;
            retryError.providerMessage = providerMessage;
            throw retryError;
        }
        if (Number.isInteger(status) && status >= 500 && status <= 599) {
            registerGlobalGemini5xx(status);
        }
        throw error;
    } finally {
        if (laneRequestStarted && lane) {
            lane.activeRequests = Math.max(0, lane.activeRequests - 1);
            lane.lastTouchedAt = Date.now();
        } else if (keyState && Number(keyState._pendingGlobalReservations || 0) > 0) {
            // Dacă apelul nu a ajuns să pornească după rezervare, nu lăsăm un
            // slot fantomă să influențeze selecția globală.
            consumeGlobalKeyReservation(keyState);
        }
        if (releaseGeminiSlot) releaseGeminiSlot();
    }
}

// ============================================================
// SAFE JSON PARSER (SANITIZER)
// ============================================================

function safeJsonParse(rawText) {
    let clean = String(rawText || '').replace(/^\uFEFF/, '').trim();

    clean = clean.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    const firstObject = clean.indexOf('{');
    const firstArray = clean.indexOf('[');
    let startIdx = -1;
    let opener = '';
    if (firstObject >= 0 && (firstArray < 0 || firstObject < firstArray)) {
        startIdx = firstObject;
        opener = '{';
    } else if (firstArray >= 0) {
        startIdx = firstArray;
        opener = '[';
    }
    const closer = opener === '[' ? ']' : '}';
    const endIdx = startIdx >= 0 ? clean.lastIndexOf(closer) : -1;
    if (startIdx >= 0 && endIdx > startIdx) clean = clean.slice(startIdx, endIdx + 1);

    function sanitize(input) {
        let out = '';
        let inString = false;
        let escaped = false;
        let stringCanBeKey = false;
        const containerStack = [];

        // O ghilimea în interiorul unui text trebuie escapata, nu tratată ca
        // încheierea șirului. Considerăm structurală ghilimeaua urmată de un
        // delimitator JSON valid; după virgulă verificăm și începutul valorii
        // următoare, pentru a nu confunda „a zis "da", apoi...” cu JSON separat.
        function isStructuralQuoteAt(source, quoteIndex, canBeKey) {
            let cursor = quoteIndex + 1;
            while (cursor < source.length && /\s/.test(source[cursor])) cursor++;
            if (cursor >= source.length) return true;

            const next = source[cursor];
            // „:” termină o cheie JSON, nu o valoare text. Protejează replici
            // precum: El mi-a spus "nu": apoi a plecat.
            if (next === ':') return canBeKey;
            if (next === '}' || next === ']') return true;
            if (next !== ',') return false;

            cursor++;
            while (cursor < source.length && /\s/.test(source[cursor])) cursor++;
            if (cursor >= source.length) return false;

            const valueStart = source[cursor];
            if (valueStart === '{' || valueStart === '[') return true;
            if (valueStart === '"') {
                let end = cursor + 1;
                let inEscape = false;
                for (; end < source.length; end++) {
                    const token = source[end];
                    if (inEscape) { inEscape = false; continue; }
                    if (token === '\\') { inEscape = true; continue; }
                    if (token === '"') break;
                }
                if (end >= source.length) return false;
                end++;
                while (end < source.length && /\s/.test(source[end])) end++;
                return source[end] === ':' || source[end] === ',' || source[end] === '}' || source[end] === ']';
            }

            const tail = source.slice(cursor);
            const literal = /^(?:true|false|null)(?=\s*[,\]}])/u.exec(tail);
            if (literal) return true;
            const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?(?=\s*[,\]}])/u.exec(tail);
            return Boolean(number);
        }

        for (let i = 0; i < input.length; i++) {
            const ch = input[i];

            if (!inString) {
                if (ch === '“' || ch === '”' || ch === '"') {
                    let previous = i - 1;
                    while (previous >= 0 && /\s/.test(input[previous])) previous--;
                    stringCanBeKey = containerStack[containerStack.length - 1] === '{' &&
                        (previous < 0 || input[previous] === '{' || input[previous] === ',');
                    out += '"';
                    inString = true;
                    escaped = false;
                    continue;
                }
                out += ch;
                if (ch === '{' || ch === '[') {
                    containerStack.push(ch);
                } else if ((ch === '}' || ch === ']') && containerStack.length) {
                    containerStack.pop();
                }
                continue;
            }

            if (escaped) {
                if ('"\\/bfnrt'.includes(ch)) out += '\\' + ch;
                else if (ch === 'u' && /^[0-9a-fA-F]{4}$/.test(input.slice(i + 1, i + 5))) {
                    out += '\\u' + input.slice(i + 1, i + 5); i += 4;
                } else {
                    out += '\\\\' + ch;
                }
                escaped = false;
                continue;
            }

            if (ch === '\\') { escaped = true; continue; }
            if (ch === '"' || ch === '”') {
                if (isStructuralQuoteAt(input, i, stringCanBeKey)) {
                    out += '"';
                    inString = false;
                    stringCanBeKey = false;
                } else if (ch === '"') {
                    // Ghilimea ASCII neescapată, dar non-structurală: o păstrăm
                    // în text, escapând-o pentru ca JSON-ul să rămână valid.
                    out += '\\"';
                } else {
                    // Ghilimelele tipografice din text nu sunt delimitatori JSON.
                    out += ch;
                }
                continue;
            }
            if (ch === '\n') { out += '\\n'; continue; }
            if (ch === '\r') { out += '\\r'; continue; }
            if (ch === '\t') { out += '\\t'; continue; }
            if (ch.charCodeAt(0) < 0x20) { out += ' '; continue; }
            out += ch;
        }
        if (escaped) out += '\\\\';
        return out;
    }

    function repairStructure(input) {
        let x = input;
        x = x.replace(/([{,]\s*)([A-Za-z0-9_-]+)(\s*:)/g, '$1"$2"$3');
        x = x.replace(/,\s*([}\]])/g, '$1');
        x = x.replace(/([}\]"\d])\s*\n\s*("[^"\n]+"\s*:)/g, '$1,\n$2');
        x = x.replace(/("(?:\\.|[^"\\])*")\s+("[^"\n]+"\s*:)/g, '$1, $2');
        return x;
    }

    const candidates = [];
    const base = sanitize(clean);
    candidates.push(base);
    candidates.push(repairStructure(base));
    candidates.push(repairStructure(base.replace(/[“”„]/g, '"')));

    for (const candidate of candidates) {
        try { return JSON.parse(candidate); } catch (_) {}
    }

    const relaxed = candidates[candidates.length - 1].replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');
    try { return JSON.parse(relaxed); } catch (err) {
        throw new Error(`JSON Parse failed: ${err.message}`);
    }
}

// ============================================================
// CHUNK ENGINE CU RETRY, RE-SPLIT SI VERIFICARE ENGLEZA
// ============================================================

// Codurile/șirurile strict numerice (de ex. 7.23.48.83 sau 11.17.55...)
// sunt conținut de subtitrare, nu proză de tradus. Le păstrăm exact și nu le
// trimitem modelului, ca să nu poată deplasa maparea ID-urilor vecine.
function isNumericVerbatimCue(text) {
    const clean = String(text || '').replace(/<[^>]+>/g, '').trim();
    if (!clean || /[\p{L}]/u.test(clean) || !/\d/u.test(clean)) return false;
    return /^[\d\s.,:;…\-–—/\\()#]+$/u.test(clean);
}

function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

// Detectează numai semnale statistice de aliniere susținute de măsurători independente.
// Lungimea și numărul de cuvinte sunt euristici, nu dovezi semantice: o singură
// fereastră poate doar avertiza, nu declanșa automat retraducerea unei zone.
const ALIGNMENT_WINDOW_SIZE = 28;
const ALIGNMENT_WINDOW_STEP = ALIGNMENT_WINDOW_SIZE; // ferestre fără suprapunere în grila principală
const ALIGNMENT_REPAIR_CHUNK_SIZE = 50;

function alignmentTextMetrics(text) {
    const clean = String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return {
        chars: clean.length,
        words: (clean.match(/[\p{L}\p{N}]+/gu) || []).length
    };
}

function alignmentPearson(pairs) {
    if (pairs.length < 18) return null;
    const xs = pairs.map(pair => pair[0]);
    const ys = pairs.map(pair => pair[1]);
    const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
    const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
    let numerator = 0;
    let sumX = 0;
    let sumY = 0;
    for (let i = 0; i < pairs.length; i++) {
        const dx = xs[i] - meanX;
        const dy = ys[i] - meanY;
        numerator += dx * dy;
        sumX += dx * dx;
        sumY += dy * dy;
    }
    const denominator = Math.sqrt(sumX * sumY);
    return denominator > 0 ? numerator / denominator : null;
}

function scoreAlignmentWindow(sourceItems, targetById, start, end, offset) {
    const charPairs = [];
    const wordPairs = [];
    for (let index = start; index <= end; index++) {
        const target = String(targetById.get(String(sourceItems[index].id)) || '');
        const targetMetrics = alignmentTextMetrics(target);
        // Ignorăm blocurile goale și foarte scurte, care nu oferă semnal util.
        if (targetMetrics.chars < 5 || targetMetrics.words < 1) continue;
        const sourceIndex = index + offset;
        if (sourceIndex < 0 || sourceIndex >= sourceItems.length) continue;
        const sourceMetrics = alignmentTextMetrics(sourceItems[sourceIndex].text);
        if (sourceMetrics.chars < 5 || sourceMetrics.words < 1) continue;
        charPairs.push([sourceMetrics.chars, targetMetrics.chars]);
        wordPairs.push([sourceMetrics.words, targetMetrics.words]);
    }

    if (charPairs.length < 18) {
        return { score: null, charsScore: null, wordsScore: null, pairs: charPairs.length };
    }
    const charsScore = alignmentPearson(charPairs);
    const wordsScore = alignmentPearson(wordPairs);
    // Ambele măsurători trebuie disponibile. Nu mai permitem ca o singură
    // corelație bună să mascheze lipsa de semnal în cealaltă.
    if (charsScore === null || wordsScore === null ||
        !Number.isFinite(charsScore) || !Number.isFinite(wordsScore)) {
        return { score: null, charsScore, wordsScore, pairs: charPairs.length };
    }
    return {
        score: (charsScore + wordsScore) / 2,
        charsScore,
        wordsScore,
        pairs: charPairs.length
    };
}

function detectTranslationAlignmentShift(sourceItems, translatedItems) {
    if (!Array.isArray(sourceItems) || sourceItems.length < ALIGNMENT_WINDOW_SIZE) return null;
    const targetById = new Map((translatedItems || []).map(item => [String(item.id), String(item.text || '')]));
    const offsets = [-2, -1, 0, 1, 2];
    const hits = [];

    // Folosim două grile independente ca să nu depindă detectarea de locul
    // în care cade limita unei ferestre. În fiecare grilă, ferestrele nu se
    // suprapun; ferestrele din grile diferite nu se cumulează niciodată ca
    // dovezi pentru confirmarea aceleiași deplasări.
    const phases = [0, Math.floor(ALIGNMENT_WINDOW_SIZE / 2)];
    for (const phase of phases) {
        const starts = [];
        for (let start = phase; start + ALIGNMENT_WINDOW_SIZE <= sourceItems.length; start += ALIGNMENT_WINDOW_STEP) {
            starts.push(start);
        }
        const finalStart = sourceItems.length - ALIGNMENT_WINDOW_SIZE;
        const lastStart = starts.length ? starts[starts.length - 1] : -1;
        // O fereastră terminală este permisă numai când suprapunerea față de
        // ultima fereastră a aceleiași grile nu depășește 25% din fereastră.
        if (finalStart >= phase && finalStart !== lastStart &&
            (lastStart < 0 || finalStart - lastStart >= Math.ceil(ALIGNMENT_WINDOW_SIZE * 0.75))) {
            starts.push(finalStart);
        }

        for (const start of starts) {
            const end = start + ALIGNMENT_WINDOW_SIZE - 1;
            const scores = Object.create(null);
            for (const offset of offsets) {
                scores[offset] = scoreAlignmentWindow(sourceItems, targetById, start, end, offset);
            }
            const baseline = scores[0];
            if (baseline.score === null) continue;

            const alternatives = offsets.filter(offset => offset !== 0 && scores[offset].score !== null);
            if (!alternatives.length) continue;
            alternatives.sort((a, b) => scores[b].score - scores[a].score);
            const shift = alternatives[0];
            const best = scores[shift];
            const scoreGain = best.score - baseline.score;
            const charsGain = best.charsScore - baseline.charsScore;
            const wordsGain = best.wordsScore - baseline.wordsScore;

            // Un semnal intră în analiză numai dacă ambele metrici susțin aceeași
            // deplasare și fiecare o preferă clar față de alinierea normală.
            if (best.score >= 0.80 && scoreGain >= 0.35 &&
                best.charsScore >= 0.75 && best.wordsScore >= 0.75 &&
                charsGain >= 0.25 && wordsGain >= 0.25 && best.pairs >= 18) {
                hits.push({
                    phase,
                    start, end, shift,
                    score: best.score,
                    baseline: baseline.score,
                    charsScore: best.charsScore,
                    wordsScore: best.wordsScore,
                    baselineChars: baseline.charsScore,
                    baselineWords: baseline.wordsScore,
                    scoreGain, charsGain, wordsGain,
                    pairs: best.pairs
                });
            }
        }
    }

    if (!hits.length) return null;
    const clusters = [];
    for (const phase of phases) {
        const phaseHits = hits.filter(hit => hit.phase === phase).sort((a, b) => a.start - b.start);
        const phaseClusters = [];
        for (const hit of phaseHits) {
            const previous = phaseClusters[phaseClusters.length - 1];
            // Confirmarea cere ferestre adiacente din aceeași grilă, deci date
            // disjuncte (cu cel mult o suprapunere terminală de maximum 25%).
            if (previous && previous.shift === hit.shift && hit.start <= previous.end + 1) {
                previous.start = Math.min(previous.start, hit.start);
                previous.end = Math.max(previous.end, hit.end);
                previous.hits.push(hit);
            } else {
                phaseClusters.push({ phase, start: hit.start, end: hit.end, shift: hit.shift, hits: [hit] });
            }
        }
        clusters.push(...phaseClusters);
    }

    const supported = clusters.filter(cluster => cluster.hits.length >= 2);
    const summarize = (cluster, confirmed) => ({
        confirmed,
        start: cluster.start,
        end: cluster.end,
        shift: cluster.shift,
        windows: cluster.hits.length,
        score: cluster.hits.reduce((sum, hit) => sum + hit.score, 0) / cluster.hits.length,
        baseline: cluster.hits.reduce((sum, hit) => sum + hit.baseline, 0) / cluster.hits.length,
        charsScore: cluster.hits.reduce((sum, hit) => sum + hit.charsScore, 0) / cluster.hits.length,
        wordsScore: cluster.hits.reduce((sum, hit) => sum + hit.wordsScore, 0) / cluster.hits.length,
        baselineChars: cluster.hits.reduce((sum, hit) => sum + hit.baselineChars, 0) / cluster.hits.length,
        baselineWords: cluster.hits.reduce((sum, hit) => sum + hit.baselineWords, 0) / cluster.hits.length
    });

    if (supported.length) {
        supported.sort((a, b) => {
            const strengthA = a.hits.length * (a.hits.reduce((sum, hit) => sum + hit.score, 0) / a.hits.length);
            const strengthB = b.hits.length * (b.hits.reduce((sum, hit) => sum + hit.score, 0) / b.hits.length);
            return strengthB - strengthA;
        });
        return summarize(supported[0], true);
    }

    // Un singur semnal statistic (chiar puternic) este doar diagnostic: nu
    // declanșează apeluri Gemini suplimentare. Este returnat doar pentru log.
    clusters.sort((a, b) => b.hits[0].score - a.hits[0].score);
    return summarize(clusters[0], false);
}

// ============================================================
// DETECTOR LOCAL DE ANOMALII DE ALINIERE PE REPLICĂ
// Cost local foarte mic, fără apeluri API. Nu deduce și nu mută traduceri;
// identifică doar tipare structurale puternice pentru o retraducere țintită.
// ============================================================
const LOCAL_ALIGNMENT_MAX_GAP = 6;
const LOCAL_ALIGNMENT_MAX_REPAIRS_PER_CHUNK = 2;
// Buget global per subtitrare: limitează riscul de 429 și timpul pe episoade lungi.
const LOCAL_ALIGNMENT_MAX_REPAIRS_PER_SUBTITLE = 2;

function localAlignmentCleanText(value) {
    return String(value || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/\s+/g, ' ')
        .trim();
}

function localAlignmentWords(value) {
    return (localAlignmentCleanText(value).match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || []).length;
}

function localAlignmentSentenceCount(value) {
    const text = localAlignmentCleanText(value);
    if (!text) return 0;
    // Interogațiile/exclamațiile și punctele de final sunt semnale aproximative;
    // nu sunt folosite separat pentru a declanșa repararea.
    return (text.match(/[.!?…]+(?=\s|$)/gu) || []).length;
}

function localAlignmentNormalize(value) {
    return localAlignmentCleanText(value)
        .toLocaleLowerCase('ro-RO')
        .replace(/[„”“"'’`]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Corelațiile pe ferestre scurte nu sunt folosite ca declanșator separat de reparații.
// Păstrăm verificările locale bazate pe anomalii structurale concrete, definite mai jos.

function detectLocalTranslationAlignmentAnomalies(sourceItems, translatedItems) {
    if (!Array.isArray(sourceItems) || sourceItems.length < 3) return [];
    const targetById = new Map((translatedItems || []).map(item => [String(item.id), String(item.text || '')]));
    const hitsByIndex = new Map();
    const mergedCueBoundaryIssues = [];

    const addHit = (index, reason, strength = 1, evidenceType = 'word-ratio') => {
        if (!hitsByIndex.has(index)) {
            hitsByIndex.set(index, { index, reasons: [], strength: 0, evidenceTypes: [] });
        }
        const hit = hitsByIndex.get(index);
        if (!hit.reasons.includes(reason)) hit.reasons.push(reason);
        if (!hit.evidenceTypes.includes(evidenceType)) hit.evidenceTypes.push(evidenceType);
        hit.strength += strength;
    };

    const normalizedSources = [];
    const normalizedTargets = [];
    for (let index = 0; index < sourceItems.length; index++) {
        const source = sourceItems[index];
        const id = String(source?.id ?? '');
        const original = localAlignmentCleanText(source?.text || '');
        const translated = localAlignmentCleanText(targetById.get(id) || '');
        normalizedSources[index] = localAlignmentNormalize(original);
        normalizedTargets[index] = localAlignmentNormalize(translated);

        if (!original || !translated || isJunkOrInterjection(original) || isJunkOrInterjection(translated)) continue;

        const sourceWords = localAlignmentWords(original);
        const targetWords = localAlignmentWords(translated);
        const sourceChars = original.length;
        const targetChars = translated.length;
        if (!sourceWords || !targetWords) continue;

        // Semnal de graniță cu încredere ridicată: un fragment-sursă scurt,
        // neterminat, a primit o traducere mult mai lungă care se încheie cu o
        // virgulă. Acest tipar poate indica faptul că modelul a absorbit cue-ul următor.
        const sourceEndsSentence = /[.!?…]["'”’)]?\s*$/u.test(original);
        const targetEndsClause = /[,;:]\s*$/u.test(translated);
        if (!sourceEndsSentence && targetEndsClause &&
            sourceWords >= 4 && sourceWords <= 6 &&
            targetWords >= sourceWords + 5 && targetWords / sourceWords >= 2.0 &&
            sourceChars <= 40 && targetChars >= 55) {
            mergedCueBoundaryIssues.push({
                start: Math.max(0, index - 1),
                end: Math.min(sourceItems.length - 1, index + 10),
                evidenceCount: 1,
                strength: 8,
                kind: 'merged-cue-boundary',
                reasons: [`fragment neterminat posibil combinat cu următorul (${sourceWords}→${targetWords} cuvinte)`]
            });
        }

        // Semnal A: o replică-sursă normală a devenit neobișnuit de scurtă.
        // Sunt necesare praguri stricte; raportul singur nu decide corectitudinea.
        if (sourceWords >= 7 && targetWords <= 4 && targetWords / sourceWords <= 0.45) {
            addHit(index, `traducere neobișnuit de scurtă (${sourceWords}→${targetWords} cuvinte)`, 2);
        }

        // Semnal B: o replică foarte scurtă a primit prea mult text românesc,
        // semn compatibil cu alipirea accidentală a replicii următoare.
        if (sourceWords <= 4 && targetWords >= 9 && targetWords / sourceWords >= 2.2) {
            addHit(index, `traducere neobișnuit de lungă (${sourceWords}→${targetWords} cuvinte)`, 2);
        } else if (sourceWords <= 2 && targetWords >= 7 && targetWords / sourceWords >= 3.0) {
            addHit(index, `expansiune extremă pentru o replică foarte scurtă (${sourceWords}→${targetWords} cuvinte)`, 2);
        }

        if (sourceChars <= 25 && targetChars >= 55 && targetChars / Math.max(1, sourceChars) >= 2.5) {
            addHit(index, `expansiune de caractere (${sourceChars}→${targetChars})`, 2, 'character-expansion');
        }

        const sourceSentences = localAlignmentSentenceCount(original);
        const targetSentences = localAlignmentSentenceCount(translated);
        if (sourceSentences <= 1 && targetSentences >= 3 && targetChars >= 55) {
            addHit(index, `mai multe propoziții în traducere decât sugerează replica-sursă (${sourceSentences}→${targetSentences})`, 2, 'sentence-count');
        }
    }

    // Semnal C: două traduceri consecutive, suficient de lungi, sunt identice,
    // dar originalele diferă. Este doar indiciu: replicile repetitive scurte
    // sunt excluse ca să nu retraducem răspunsuri uzuale precum „Da”.
    for (let index = 0; index < sourceItems.length - 1; index++) {
        const firstSource = String(sourceItems[index]?.text || '');
        const secondSource = String(sourceItems[index + 1]?.text || '');
        const firstTarget = normalizedTargets[index] || '';
        const secondTarget = normalizedTargets[index + 1] || '';
        if (!firstTarget || firstTarget !== secondTarget) continue;
        if (normalizedSources[index] === normalizedSources[index + 1]) continue;
        if (isJunkOrInterjection(firstSource) || isJunkOrInterjection(secondSource)) continue;
        if (localAlignmentWords(firstTarget) < 4 || firstTarget.length < 18) continue;
        addHit(index, 'traduceri consecutive identice pentru originale diferite', 3, 'duplicate-translation');
        addHit(index + 1, 'traduceri consecutive identice pentru originale diferite', 3, 'duplicate-translation');
    }

    const hits = [...hitsByIndex.values()].sort((a, b) => a.index - b.index);
    if (!hits.length && !mergedCueBoundaryIssues.length) return [];

    const clusters = [];
    for (const hit of hits) {
        const previous = clusters[clusters.length - 1];
        if (previous && hit.index - previous.end <= LOCAL_ALIGNMENT_MAX_GAP) {
            previous.end = hit.index;
            previous.hits.push(hit);
            previous.strength += hit.strength;
            for (const reason of hit.reasons) {
                if (!previous.reasons.includes(reason)) previous.reasons.push(reason);
            }
        } else {
            clusters.push({
                start: hit.index,
                end: hit.index,
                hits: [hit],
                strength: hit.strength,
                reasons: [...hit.reasons]
            });
        }
    }

    // Prag mai maleabil: diferențele de număr de cuvinte sunt un semnal slab,
    // deoarece româna poate formula firesc o replică mult mai scurt sau mai lung.
    // Trei anomalii bazate numai pe raportul cuvintelor NU mai declanșează singure
    // apeluri Gemini. Cerem fie 4 replici distincte atipice, fie 3 plus o confirmare
    // de alt tip (caractere/propoziții), fie ramura separată pentru duplicate repetate.
    const structuralIssues = clusters
        .filter(cluster => {
            const structuralHits = cluster.hits.filter(hit =>
                hit.reasons.some(reason => !reason.startsWith('traduceri consecutive identice'))
            );
            const duplicateHits = cluster.hits.filter(hit =>
                hit.reasons.some(reason => reason.startsWith('traduceri consecutive identice'))
            );
            const hasIndependentEvidence = cluster.hits.some(hit =>
                hit.evidenceTypes.some(type => type === 'character-expansion' || type === 'sentence-count')
            );
            // Două traduceri identice pot fi refren/replică repetată; păstrăm ramura
            // istorică numai dacă există și un indiciu structural suplimentar.
            return (structuralHits.length >= 4 && cluster.strength >= 8) ||
                (structuralHits.length >= 3 && cluster.strength >= 6 && hasIndependentEvidence) ||
                (structuralHits.length >= 1 && duplicateHits.length >= 2 && cluster.strength >= 9);
        })
        .map(cluster => ({
            start: cluster.start,
            end: cluster.end,
            evidenceCount: cluster.hits.length,
            strength: cluster.strength,
            kind: 'structural-anomaly',
            reasons: cluster.reasons
        }));

    // Un singur indiciu „sursă neterminată + traducere lungă cu virgulă” este
    // ambiguu: poate fi și o formulare românească validă. Îl folosim la reparare
    // doar dacă este susținut de o anomalie structurală confirmată în aceeași zonă.
    const confirmedMergedCueBoundaryIssues = mergedCueBoundaryIssues.filter(boundary =>
        structuralIssues.some(issue => issue.start <= boundary.end && issue.end >= boundary.start)
    );

    // Corelațiile globale de lungime și indiciile izolate rămân doar diagnostice;
    // nu consumă bugetul limitat de retraduceri fără corroborare locală independentă.
    return [...confirmedMergedCueBoundaryIssues, ...structuralIssues]
        .sort((a, b) => b.strength - a.strength || a.start - b.start);
}

function canRetranslateAlignmentItem(item) {
    if (item?.musicOnly) return false;
    const source = String(item?.text || '').trim();
    if (!source || isEffectivelyEmptySubtitleText(source) || isJunkOrInterjection(source)) return false;
    // Formatterul curent elimină cifrele și punctuația fără litere; nu repetăm
    // cereri pentru coduri numerice pe care ieșirea nu le poate păstra oricum.
    return /[\p{L}]/u.test(source);
}

async function repairTranslationAlignmentRange(sourceChunk, currentResult, detection, allItems,
    absoluteChunkStart, keyStates, globalChunkIndex, totalChunks) {
    const start = Math.max(0, detection.start - 2);
    const end = Math.min(sourceChunk.length - 1, detection.end + 2);
    const currentById = new Map((currentResult || []).map(item => [String(item.id), String(item.text || '')]));
    const replacementById = new Map();

    // Păstrăm segmentele contigue și le grupăm în ferestre fixe. Nu mai lansăm
    // cereri separate de 1–2 replici când întâlnim o replică de tip junk/filler.
    // Rezultatele replicilor care nu trebuie retraduse nu sunt aplicate peste
    // textul deja obținut la traducerea principală.
    for (let runStart = start; runStart <= end; runStart += ALIGNMENT_REPAIR_CHUNK_SIZE) {
        const runEnd = Math.min(end, runStart + ALIGNMENT_REPAIR_CHUNK_SIZE - 1);
        const piece = sourceChunk.slice(runStart, runEnd + 1);
        const candidateIds = new Set(
            piece.filter(canRetranslateAlignmentItem).map(item => String(item.id))
        );
        if (!candidateIds.size) continue;

        const absoluteStart = absoluteChunkStart + runStart;
        const repaired = await processChunkWithRetry(
            piece,
            allItems,
            absoluteStart,
            absoluteStart + piece.length,
            [],
            keyStates,
            globalChunkIndex,
            totalChunks,
            0,
            true
        );
        for (const item of repaired) {
            const id = String(item.id);
            if (candidateIds.has(id)) replacementById.set(id, String(item.text || ''));
        }
    }

    return sourceChunk.map(item => {
        const id = String(item.id);
        if (isNumericVerbatimCue(item.text)) return { id: item.id, text: String(item.text || '') };
        if (replacementById.has(id)) return { id: item.id, text: replacementById.get(id) };
        return { id: item.id, text: currentById.get(id) || ' ' };
    });
}

function isJunkOrInterjection(text) {
    const clean = String(text || '').replace(/<[^>]+>/g, '').trim();
    if (!clean) return true;

    // Marcatori goi/tehnici care nu reprezintă dialog real. Sunt ignorați
    // complet de verificările de traducere, ca să nu apară în loguri ca suspecți.
    if (/^[\s\-–—._,;:!?…'"~^`´‚„“”‘’()\[\]{}|\\/♪♫♬♩#]+$/.test(clean)) return true;

    if (isOnlyStandaloneFillerSequence(clean)) return true;
    return false;
}

function hasUntranslatedEnglish(original, translated) {
    if (!original || !translated) return false;

    const origClean = String(original).replace(/<[^>]+>/g, '').trim();
    const transClean = String(translated).replace(/<[^>]+>/g, '').trim();
    if (isJunkOrInterjection(origClean) || !transClean || transClean.length <= 2) return false;

    const normalize = value => String(value)
        .toLowerCase().replace(/[“”„"’']/g, "'").replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
    const originalNorm = normalize(origClean);
    const translatedNorm = normalize(transClean);

    const strongEnglish = new Set([
        'the','and','but','if','then','than','they','them','their','we','us','our','you','your','he','him','his','she','her','it','its',
        'this','that','these','those','what','which','who','where','when','why','how','with','from','into','onto','about','after','before',
        'without','against','between','through','because','while','would','could','should','will','shall','can','cannot','do','does','did',
        'have','has','had','not',"don't","isn't","won't","can't","didn't",'please','sorry','thanks','thank','yes',
        'for','of','in','on','at','to','by','as'
    ]);
    const englishMarkers = new Set([...strongEnglish,
        'need','needs','needed','want','wants','wanted','know','knows','knew','think','thought','mean','means','look','looks','looked',
        'make','makes','made','get','gets','got','go','goes','went','come','comes','came','take','takes','took','give','gives','gave',
        'see','sees','saw','say','says','said','tell','tells','told','find','finds','found','leave','leaves','left','keep','keeps','kept',
        'disregard','forget','ignore','remember','good','bad','right','wrong','now','here','there','very','really','just','only','still',
        'already','first','last','next','back','again','colonel','minutes','ready','killed','enough','nothing','maybe','little','well','sure',
        'itself','himself','herself','themselves','myself','yourself','such','indictment','however','although','though','perhaps','rather','still',
        // Cuvinte englezești izolate care au fost observate în output și care
        // nu sunt forme românești valide. Sunt folosite doar ca semnal de control.
        'innate'
    ]);

    const tokenize = value => value.match(/[a-zăâîșț]+(?:'[a-zăâîșț]+)?/g) || [];
    const tw = tokenize(translatedNorm);
    const ow = tokenize(originalNorm);

    const namedTitle = /\b(?:The\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,5}|Nobody\s+Beats\s+the\s+Wiz)\b/.test(transClean);
    const romanianSignals = /\b(?:și|să|se|este|sunt|era|erau|nu|da|că|ca|cu|de|din|în|pe|la|un|o|eu|tu|el|ea|noi|voi|ei|ele|mai|foarte|pentru|dar|sau|care|ce|cine|cum|unde|când|aici|acolo|trebuie|poate|fost|avea|am|ai|are|au|mă|te|îl|îi|mi|ți|lor|lui|mea|ta|tău|meu)\b/i;

    if (originalNorm === translatedNorm) {
        if (namedTitle && !romanianSignals.test(transClean) && tw.length <= 8) return false;
        const strong = tw.filter(w => strongEnglish.has(w)).length;
        const markers = tw.filter(w => englishMarkers.has(w)).length;
        if (strong >= 1 || markers >= 2) return true;
        if (tw.length >= 5 && markers >= 2) return true;
        return false;
    }

    const distinctive = new Set(['the','from','however','although','because','without','between','maybe','please','sorry','thanks','thank','your','would','could','should','cannot','itself','such','indictment','secure']);
    const distinctiveHits = tw.filter(w => distinctive.has(w));

    // Protejează numele proprii păstrate intenționat din original, inclusiv
    // nume de forma „Tyler, the Creator”. Dacă secvența englezească apare
    // identic și în ORIGINAL și este clar parte dintr-un nume propriu, nu o
    // marca drept cuvânt netradus.
    const properNameMatches = transClean.match(/\b[A-Z][A-Za-zÀ-ÖØ-öø-ÿ]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ]+){0,3}(?:,\s*the\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ]+)?\b/g) || [];
    const hasPreservedProperName = properNameMatches.some(name => {
        const normalizedName = normalize(name);
        return normalizedName.length >= 4 && originalNorm.includes(normalizedName);
    });

    if (distinctiveHits.length) {
        if (hasPreservedProperName && distinctiveHits.every(w => w === 'the' || w === 'a' || w === 'an')) return false;
        if (namedTitle && distinctiveHits.every(w => w === 'the' || w === 'a' || w === 'an')) return false;
        return true;
    }

    if (tw.length <= 8) {
        const strong = tw.filter(w => strongEnglish.has(w)).length;
        const originalStrong = ow.filter(w => strongEnglish.has(w)).length;
        const originalMarkers = ow.filter(w => englishMarkers.has(w)).length;
        if (strong >= 2 && (originalStrong >= 1 || originalMarkers >= 2)) return true;

        const obviousPhrases = [
            /\b(need|want|know|think|look|come|go|get|take|give|tell|find|leave|keep)\s+(me|us|you|him|her|them|it)\b/,
            /\b(i|you|we|they|he|she)\s+(need|want|know|think|have|can|will|would|could|should)\b/,
            /\b(and|but|or)\s+(disregard|forget|ignore|remember)\b/
        ];
        if (obviousPhrases.some(rx => rx.test(translatedNorm))) return true;
    }

    if (tw.length >= 4) {
        const markerCount = tw.filter(w => englishMarkers.has(w)).length;
        const strongCount = tw.filter(w => strongEnglish.has(w)).length;
        const ratio = markerCount / tw.length;
        if (markerCount >= 5 && ratio >= 0.30) return true;
        if (strongCount >= 3 && ratio >= 0.35) return true;
    }
    return false;
}

function hasCorruptedSubtitleText(text, originalText) {
    if (isJunkOrInterjection(originalText)) return false;

    const s = String(text || '').replace(/<[^>]+>/g, '').trim();
    if (!s) return true;
    if (/^(?:[-–—\s.?!,;:'"])+$/.test(s)) return true;
    if (/[\u0400-\u04FF\u4E00-\u9FFF\u3040-\u30FF]/.test(s)) return true;
    // Detectează coruperea de capitalizare dintr-un cuvânt (de ex. „cEEa”).
    // Nu marchează acronimele, „iPhone” sau „iOS”; cere și o terminație cu litere mici.
    if (/(?<![\p{L}])[\p{Ll}][\p{Lu}]{2,}[\p{Ll}]+(?![\p{L}])/u.test(s)) return true;

    return false;
}

// ============================================================
// SOURCE-FIDELITY HEURISTIC — DEZACTIVATĂ ÎN v12.78.252
// După testele repetate, această euristică a produs suspiciuni neconfirmate.
// Funcțiile rămân ca wrapper-e compatibile; post-check, grammar review, semantic
// spot-check, empty recovery și celelalte verificări independente rămân active.
// ============================================================
function getMissingExplicitAnatomicalTerms(original, translation) {
    return [];
}

function getSourceFidelityIssues(original, translation) {
    return [];
}

function hasLostExplicitSourceTerm(original, translation) {
    return false;
}

function applyBecauseOfWhatISaidCorrection(original, translation) {
    let text = String(translation || '');
    const sourceNorm = String(original || '').replace(/<[^>]+>/g, ' ').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
    if (!/\bbecause of what i said\b/i.test(sourceNorm)) return text;
    return text.replace(/(?<![\p{L}])din\s+cauz[ăa]\s+la\s+ce(?![\p{L}])/iu, match => {
        const replacement = 'din cauza a ceea ce';
        if (match === match.toLocaleUpperCase('ro-RO')) return replacement.toLocaleUpperCase('ro-RO');
        return match[0] === match[0].toLocaleUpperCase('ro-RO')
            ? replacement.charAt(0).toLocaleUpperCase('ro-RO') + replacement.slice(1)
            : replacement;
    });
}

function applySourceGroundedSemanticFixes(original, translation) {
    let text = applyBecauseOfWhatISaidCorrection(original, translation);
    const sourceText = String(original || '').replace(/<[^>]+>/g, ' ');
    const sourceNorm = sourceText.toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();

    // Reparație foarte îngustă, activată numai dacă engleza conține verbul tranzitiv
    // „dry + my/the vagina”. Nu schimbă alte utilizări ale lui „mă usucă”.
    if (/\b(?:dry|dries|dried|drying)\s+(?:my|the)\s+vagina\b/i.test(sourceNorm)) {
        text = text.replace(/\b(mă|ma)\s+usuc[ăa]\s+(?:în|in|la)\s+vagin(?:ul)?\b/giu, match => {
            const startsUpper = match[0] === match[0].toLocaleUpperCase('ro-RO');
            return startsUpper ? 'Îmi usucă vaginul' : 'îmi usucă vaginul';
        });
    }

    // Pentru un singur hat/cap/beanie în sursă, conservăm întâi numărul gramatical.
    // Normalizăm doar un mic set de echivalente evidente pentru acoperământul de cap.
    const hasSingularHatSource = /\b(?:a|an|one)\s+(?:(?:[a-z]+)\s+){0,2}(?:hat|cap|beanie|bonnet)\b/i.test(sourceNorm);
    const sourceAlsoNamesPluralHats = /\b(?:hats|caps|beanies|bonnets)\b/i.test(sourceNorm);
    const hasDiminutiveCue = /\b(?:little|small|tiny|miniature|cute|baby|adorable)\b/i.test(sourceNorm);
    if (hasSingularHatSource && !sourceAlsoNamesPluralHats) {
        const numberReplacements = [
            [/(?<![\p{L}\p{N}_])căciuli(?:le)?(?![\p{L}\p{N}_])/giu, 'căciulă'],
            [/(?<![\p{L}\p{N}_])caciuli(?:le)?(?![\p{L}\p{N}_])/giu, 'căciulă'],
            [/(?<![\p{L}\p{N}_])șepci(?![\p{L}\p{N}_])/giu, 'șapcă'],
            [/(?<![\p{L}\p{N}_])sepci(?![\p{L}\p{N}_])/giu, 'șapcă'],
            [/(?<![\p{L}\p{N}_])fesuri(?![\p{L}\p{N}_])/giu, 'fes'],
            [/(?<![\p{L}\p{N}_])bonete(?![\p{L}\p{N}_])/giu, 'bonetă'],
            [/(?<![\p{L}\p{N}_])pălării(?![\p{L}\p{N}_])/giu, 'pălărie'],
            [/(?<![\p{L}\p{N}_])palarii(?![\p{L}\p{N}_])/giu, 'pălărie']
        ];
        for (const [pattern, replacement] of numberReplacements) {
            text = text.replace(pattern, match => {
                const startsUpper = match[0] === match[0].toLocaleUpperCase('ro-RO');
                return startsUpper ? replacement[0].toLocaleUpperCase('ro-RO') + replacement.slice(1) : replacement;
            });
        }
        // Pluralul diminutivelor devine singular, păstrând diminutivul doar când sursa îl susține.
        if (hasDiminutiveCue) {
            text = text.replace(/(?<![\p{L}\p{N}_])căciulițe(?![\p{L}\p{N}_])/giu, 'căciuliță');
            text = text.replace(/(?<![\p{L}\p{N}_])caciulite(?![\p{L}\p{N}_])/giu, 'căciuliță');
            text = text.replace(/(?<![\p{L}\p{N}_])șepcuțe(?![\p{L}\p{N}_])/giu, 'șepcuță');
            text = text.replace(/(?<![\p{L}\p{N}_])sepcute(?![\p{L}\p{N}_])/giu, 'șepcuță');
        } else {
            text = text.replace(/(?<![\p{L}\p{N}_])căciulițe(?![\p{L}\p{N}_])/giu, 'căciulă');
            text = text.replace(/(?<![\p{L}\p{N}_])caciulite(?![\p{L}\p{N}_])/giu, 'căciulă');
            text = text.replace(/(?<![\p{L}\p{N}_])căciuliță(?![\p{L}\p{N}_])/giu, match => match[0] === match[0].toLocaleUpperCase('ro-RO') ? 'Căciulă' : 'căciulă');
            text = text.replace(/(?<![\p{L}\p{N}_])caciulita(?![\p{L}\p{N}_])/giu, match => match[0] === match[0].toLocaleUpperCase('ro-RO') ? 'Căciulă' : 'căciulă');
            text = text.replace(/(?<![\p{L}\p{N}_])șepcuțe(?![\p{L}\p{N}_])/giu, 'șapcă');
            text = text.replace(/(?<![\p{L}\p{N}_])sepcute(?![\p{L}\p{N}_])/giu, 'șapcă');
            text = text.replace(/(?<![\p{L}\p{N}_])șepcuță(?![\p{L}\p{N}_])/giu, match => match[0] === match[0].toLocaleUpperCase('ro-RO') ? 'Șapcă' : 'șapcă');
            text = text.replace(/(?<![\p{L}\p{N}_])sepcuta(?![\p{L}\p{N}_])/giu, match => match[0] === match[0].toLocaleUpperCase('ro-RO') ? 'Șapcă' : 'șapcă');
        }
    }

    // Corecții strict ancorate în sursă pentru erori de traducere demonstrate.
    // Se activează doar dacă originalul confirmă sensul; nu sunt reguli globale de vocabular.
    if (/\bresponse\b/i.test(sourceNorm) && /(?<![\p{L}])retrasul(?![\p{L}])/iu.test(text)) {
        text = text.replace(/(?<![\p{L}])retrasul(?![\p{L}])/iu, match =>
            match[0] === match[0].toLocaleUpperCase('ro-RO') ? 'Răspunsul' : 'răspunsul');
    }

    if (/\b(?:but\s+)?you(?:'re|\s+are)\s+not\s+sorry\b/i.test(sourceNorm) &&
        /(?<![\p{L}])nu\s+ești\s+(?:nici\s+)?părere\s+de\s+rău(?![\p{L}])/iu.test(text)) {
        text = text.replace(/(?<![\p{L}])nu\s+ești\s+(?:nici\s+)?părere\s+de\s+rău(?![\p{L}])/iu, match =>
            match[0] === match[0].toLocaleUpperCase('ro-RO') ? 'Nu-ți pare rău' : 'nu-ți pare rău');
    }

    if (/\bshould\s+at\s+least\s+tell\b/i.test(sourceNorm)) {
        text = text.replace(/(?<![\p{L}])ar\s+trebui\s+măcar\s+(le|îi|mi|ne|vă|te|mă)\s+(spunem|spun|zicem|dăm|dau|spunem|anunțăm|anuntam)(?![\p{L}])/iu,
            (match, pronoun, verb) => {
                const corrected = `ar trebui măcar să ${pronoun.toLocaleLowerCase('ro-RO')} ${verb.toLocaleLowerCase('ro-RO')}`;
                return match[0] === match[0].toLocaleUpperCase('ro-RO')
                    ? corrected.charAt(0).toLocaleUpperCase('ro-RO') + corrected.slice(1)
                    : corrected;
            });
    }

    if (/\bcould\s+i\s+have\s+a\s+word\b/i.test(sourceNorm) &&
        /(?<![\p{L}])pot\s+să\s+vorbim(?![\p{L}])/iu.test(text)) {
        text = text.replace(/(?<![\p{L}])pot\s+să\s+vorbim(?![\p{L}])/iu, match =>
            match[0] === match[0].toLocaleUpperCase('ro-RO') ? 'Pot să vorbesc' : 'pot să vorbesc');
    }

    // Elimină engleza redundantă numai când aceeași informație a fost deja tradusă corect.
    if (/\boutnumbered\b/i.test(sourceNorm) && /\boutnumbered\b/i.test(text) &&
        /(?:depășiți numeric|în inferioritate numerică)/iu.test(text)) {
        text = text.replace(/(?<![\p{L}])([Ee]ram|[Ss]untem|[Ee]rau)\s+outnumbered\s*(?:[.!?…]{1,3})?\s*\1\s+/iu, '$1 ');
        text = text.replace(/\s{2,}/g, ' ').replace(/\s+([,.!?;:])/g, '$1').trim();
    }

    // Corecții locale suplimentare bazate strict pe concordanța sursă-țintă.
    // Nu generează apeluri AI; sunt aplicate atât înainte de Quality Retry,
    // cât și în protecția finală de dinaintea exportului.
    if (/\ber\s+is\s+chaos\b/i.test(sourceNorm) &&
        /\burgențele\s+(?:e|este)\s+haos\b/iu.test(text)) {
        text = text.replace(/\burgențele\s+(?:e|este)\s+haos\b/iu, 'La Urgențe e haos');
    }

    if (/^\s*yeah,\s*i(?:\.{2,}|…)\s*i(?:\.{2,}|…)\s*$/i.test(sourceText) &&
        /^\s*da,\s*am(?:\.{3,}|…)\s*$/iu.test(text)) {
        text = text.replace(/^\s*da,\s*am(?:\.{3,}|…)\s*$/iu, 'Da, eu... eu...');
    }

    if (/\bask\s+you\s+to\s+pick\s+him\s+up\b/i.test(sourceNorm) &&
        /\bsă[- ](?:i|îi)\s+ceri\s+să\s+te\s+ia\b/iu.test(text)) {
        text = text.replace(/\bsă[- ](?:i|îi)\s+ceri\s+să\s+te\s+ia\b/iu, match =>
            (match[0] === match[0].toLocaleUpperCase('ro-RO') ? 'Să-ți ceară să-l iei' : 'să-ți ceară să-l iei'));
    }

    if (/\bbachelorette\s+party\b/i.test(sourceNorm) && /\bburlacilor\b/iu.test(text)) {
        text = text.replace(/\bburlacilor\b/giu, match =>
            match[0] === match[0].toLocaleUpperCase('ro-RO') ? 'Burlăcițelor' : 'burlăcițelor');
    }

    if (/\bnext\s+round(?:['’]s|\s+is)\s+on\s+me\b/i.test(sourceNorm) &&
        /\b(?:următorul|urmatorul)\s+(?:rând|rand)(?:ul)?\s+(?:e|este)\s+de\s+la\s+mine\b/iu.test(text)) {
        text = text.replace(/\b(?:următorul|urmatorul)\s+(?:rând|rand)(?:ul)?\s+(?:e|este)\s+de\s+la\s+mine\b/iu,
            match => match[0] === match[0].toLocaleUpperCase('ro-RO')
                ? 'Următoarea rundă e din partea mea'
                : 'Următoarea rundă e din partea mea');
    }

    if (/\bi\s+used\s+to\s+hate\s+fado\b/i.test(sourceNorm) &&
        /\burăsc\s+fado\b/iu.test(text) &&
        !/\b(?:înainte|inainte|odată|odata|cândva|candva|pe\s+vremuri|odinioară|odinioara)\b/iu.test(text)) {
        text = text.replace(/\burăsc\s+fado\b/iu, match =>
            match[0] === match[0].toLocaleUpperCase('ro-RO') ? 'Înainte uram fado' : 'înainte uram fado');
    }

    if (/\bcould\s+do\s+the\s+dance\b/i.test(sourceNorm) &&
        /\bsă[- ](?:l|îl|il)\s+dansul\b/iu.test(text)) {
        text = text.replace(/\bsă[- ](?:l|îl|il)\s+dansul\b/iu, match =>
            match[0] === match[0].toLocaleUpperCase('ro-RO') ? 'Să fac dansul' : 'să fac dansul');
    }

    return text;
}

function normalizeTranslationPayload(parsed) {
    if (Array.isArray(parsed)) {
        const dict = Object.create(null);
        for (const item of parsed) {
            if (!item || item.id === undefined) continue;
            dict[String(item.id)] = item.text === undefined ? '' : String(item.text);
        }
        return dict;
    }
    if (parsed && typeof parsed === 'object') {
        const source = parsed.translations && typeof parsed.translations === 'object'
            ? parsed.translations
            : parsed;
        return source;
    }
    return Object.create(null);
}

async function processChunkWithRetry(chunk, allItems, chunkStart, chunkEnd, previousTranslatedContext, keyStates, globalChunkIndex, totalChunks, depth = 0, alignmentRepair = false, deferred429Retry = false) {
    const requestChunk = chunk.filter(obj => !isNumericVerbatimCue(obj.text) && !obj.musicOnly);
    const prompt = requestChunk.length
        ? buildTranslationPrompt(requestChunk, allItems, chunkStart, chunkEnd, previousTranslatedContext)
        : '';
    const verbatimCueCount = chunk.length - requestChunk.length;
    const musicOnlyCount = chunk.filter(obj => obj.musicOnly).length;
    const numericVerbatimCount = chunk.filter(obj => isNumericVerbatimCue(obj.text)).length;
    const passthroughNote = [
        numericVerbatimCount ? `${numericVerbatimCount} coduri numerice copiate exact` : '',
        musicOnlyCount ? `${musicOnlyCount} blocuri cu versuri păstrate` : ''
    ].filter(Boolean).join('; ');
    if (!requestChunk.length) {
        return chunk.map(obj => ({ id: obj.id, text: String(obj.text || '') }));
    }
    let lastError = null;

    // Tură inițială: cel mult o rotație prin pool, fără a aștepta separat
    // fiecare cooldown produs de alte calupuri concurente. Dacă aceasta eșuează,
    // calupul intră în coada coordonată. Recuperarea primește până la 3 ture prin
    // pool (minimum 8 încercări) și poate aștepta primul proiect eligibil.
    // 5xx păstrează un buget inițial de 8 încercări și backoff-ul global.
    const maxKeyAttempts = Math.max(1, Array.isArray(keyStates) ? keyStates.length : 1);
    const maxTransientAttempts = 8;
    // Ca în v148, după 429 păstrăm un buget real de recuperare (până la 3 ture prin pool).
    // Pentru tura rapidă, permitem doar două proiecte încercate înainte de a pune calupul în coada coordonată.
    const maxRateLimitAttempts = Math.max(8, Array.isArray(keyStates) ? keyStates.length * 3 : 8);
    const maxFast429Attempts = 2;
    const maxAttemptsThisPass = deferred429Retry ? maxRateLimitAttempts : maxKeyAttempts;
    const attemptedKeyStates = new Set();
    let sawRateLimit429 = false;
    let rateLimitAttempts = 0;

    let attempt = 0; // numărul de apeluri API reale; selectarea/așteptarea nu consumă bugetul
    let transientAttempts = 0;
    while (attempt < maxAttemptsThisPass) {
        let keyState = null;
        try {
            keyState = await getAvailableKey(keyStates, {
                excludeStates: attemptedKeyStates,
                // În tura inițială amânăm calupul dacă nu există alternativă imediată.
                // În recuperare așteptăm cooldown-ul și resetăm rotația după ce se eliberează pool-ul.
                failFastIfNoAvailable: !deferred429Retry
            });
            attemptedKeyStates.add(keyState);
            attempt++;

            if (alignmentRepair) {
                console.log(`${c.cyan}➤ [Aliniere] Retraduc segment punctual (${chunk.length} replici)...${c.reset}`);
            } else {
                console.log(`${c.cyan}➤ [Gemini] Traduc calup ${globalChunkIndex + 1}/${totalChunks}...${c.reset}`);
            }

            const requestLabel = alignmentRepair
                ? `Segment aliniere pentru calup ${globalChunkIndex + 1}/${totalChunks}`
                : `Calup ${globalChunkIndex + 1}/${totalChunks}`;
            const raw = await callGemini(prompt, keyState, { requestLabel, responseSchema: buildTranslationResponseSchema(requestChunk) });
            const parsed = safeJsonParse(raw);
            const dict = normalizeTranslationPayload(parsed);

            // Verificăm rezultatul DUPĂ același formatter care va fi folosit la ieșire.
            // Astfel, un răspuns format doar din ezitări/interjecții eliminate de formatter
            // este tratat drept gol și reparat în calupul curent, nu abia la Empty Recovery.
            // Cache-ul evită să rulăm formatterul repetat pentru aceeași valoare a aceluiași ID.
            const formattedTranslationCache = new Map();
            const getUsableFormattedTranslation = (id, value) => {
                if (value === undefined || value === null) return '';
                const raw = String(value);
                const cacheKey = String(id);
                const cached = formattedTranslationCache.get(cacheKey);
                if (cached && cached.raw === raw) return cached.formatted;

                if (!raw.replace(/<[^>]+>/g, '').trim()) {
                    formattedTranslationCache.set(cacheKey, { raw, formatted: '' });
                    return '';
                }

                let formatted = '';
                try {
                    formatted = formatSubtitleLine(raw);
                } catch (_) {
                    formatted = '';
                }
                if (!String(formatted || '').replace(/<[^>]+>/g, '').trim()) formatted = '';
                formattedTranslationCache.set(cacheKey, { raw, formatted });
                return formatted;
            };
            const hasUsableTranslation = (id, value) => Boolean(getUsableFormattedTranslation(id, value));

            const missingItems = requestChunk.filter(obj => !hasUsableTranslation(obj.id, dict[String(obj.id)]));
            const missingKeyCount = missingItems.filter(obj => !Object.prototype.hasOwnProperty.call(dict, String(obj.id))).length;
            const presentButUnusableCount = missingItems.length - missingKeyCount;

            // Cue-urile strict numerice sunt copiate byte-for-byte după parsare;
            // toate celelalte ID-uri folosesc exclusiv răspunsul asociat explicit de model.
            const results = chunk.map(obj => {
                if (isNumericVerbatimCue(obj.text) || obj.musicOnly) {
                    return { id: obj.id, text: String(obj.text || '') };
                }
                const candidate = getUsableFormattedTranslation(obj.id, dict[String(obj.id)]);
                if (candidate && !hasAllProtectedMusicTokens(obj, candidate)) {
                    console.log(`${c.yellow}[Versuri muzicale] ID ${obj.id}: Gemini a modificat/eliminat un token protejat; păstrez sursa acestui cue pentru a nu altera versurile.${c.reset}`);
                    return { id: obj.id, text: String(obj.text || '') };
                }
                return { id: obj.id, text: candidate || ' ' };
            });

            // Verificările de limbă și fidelitate rulează o singură dată după toate calupurile,
            // unde pot corecta problemele contextual în loc să emită avertismente premature.

            if (missingItems.length > 0) {
                const usableCount = chunk.length - missingItems.length;
                const passthroughSuffix = passthroughNote ? `; ${passthroughNote}` : '';
                if (alignmentRepair) {
                    console.log(`${c.yellow}⚠ [Aliniere] Segment punctual: ${usableCount}/${chunk.length} intrări păstrate/utilizabile${passthroughSuffix}; ${missingItems.length} ID-uri goale lăsate pentru recuperarea existentă.${c.reset}`);
                } else {
                    console.log(`${c.yellow}⚠ [Gemini] Calup ${globalChunkIndex + 1}/${totalChunks}: ${usableCount}/${chunk.length} intrări păstrate/utilizabile${passthroughSuffix}; ${missingItems.length} de recuperat (chei absente: ${missingKeyCount}; valori prezente dar goale/eliminate de formatter: ${presentButUnusableCount}); fără split.${c.reset}`);
                }
            } else if (alignmentRepair) {
                console.log(`${c.green}✔ [Aliniere] Segment punctual finalizat (${chunk.length}/${chunk.length} replici păstrate).${c.reset}`);
            } else {
                const passthroughSuffix = passthroughNote ? `; ${passthroughNote}` : '';
                console.log(`${c.green}✔ [Gemini] Calup ${globalChunkIndex + 1}/${totalChunks} finalizat! (${chunk.length}/${chunk.length} linii${passthroughSuffix})${c.reset}`);
            }
            return results;
        } catch (error) {
            lastError = error;
            const is429 = error.isRateLimit429 === true || error.message.includes('429');
            if (is429) {
                sawRateLimit429 = true;
                rateLimitAttempts++;
            }
            const isDailyQuotaBlocked = error.isPermanentQuotaBlock === true;
            const errorMessage = String(error?.message || error);
            const status = Number(error?.response?.status || 0);
            const is5xx = (status >= 500 && status <= 599) || /status code 5\d\d/i.test(errorMessage);
            const isTransient = !isDailyQuotaBlocked && (is429 || is5xx);

            if (error?.isGlobalWaveDeferral === true) {
                // Nu este un apel API eșuat: limita comună era deja activă.
                // Păstrăm calupul pentru coada care așteaptă expirarea pauzei.
                break;
            }

            if (is429 && !isDailyQuotaBlocked) {
                const retryLimit = deferred429Retry ? maxRateLimitAttempts : maxKeyAttempts;
                if (error?.isPoolRotationExhausted && deferred429Retry && attempt < retryLimit) {
                    // Toate proiectele neîncercate au cooldown. Nu abandonăm calupul:
                    // dacă există deja un proiect disponibil, pornim o tură nouă acum;
                    // altfel așteptăm cel mai scurt cooldown din pool înainte de reset.
                    const availability = getGeminiPoolAvailability(keyStates);
                    const now = Date.now();
                    if (!availability.available.length && !availability.temporarilyPaused.length) {
                        keyStates._secondaryRecovery429Hold = true;
                        keyStates._emptyRecoveryIndividualRetriesDisabled = true;
                            break;
                    }
                    const globalUntil = Math.max(
                        Number(geminiRequestControl.cooldownUntil || 0),
                        Number(geminiRequestControl.global429PauseUntil || 0),
                        Number(getGlobal429Until(keyStates) || 0)
                    );
                    const projectWait = getMinimumTransientPoolCooldownMs(keyStates, now, true);
                    const waitMs = availability.available.length
                        ? Math.max(0, globalUntil - now)
                        : Math.max(Math.max(0, globalUntil - now), projectWait);
                    if (waitMs > 0) {
                        await sleep(Math.min(waitMs, 120000) + 250);
                    }
                    attemptedKeyStates.clear();
                    keyStates._429WaveFailedProjects = new Set();
                    keyStates._429WaveExhaustionLogged = false;
                    continue;
                }
                if (!deferred429Retry && rateLimitAttempts >= maxFast429Attempts) {
                    break;
                }
                if (!error?.isPoolRotationExhausted && attempt < retryLimit) {
                    await sleep(GEMINI_429_INTER_REQUEST_PAUSE_MS + Math.floor(Math.random() * 501));
                    continue;
                }
                if (attempt >= retryLimit) {
                    console.log(`${c.yellow}[Gemini Recovery] Bugetul 429 a fost epuizat (${attempt}/${retryLimit}); păstrez replicile nerezolvate pentru QA FINAL.${c.reset}`);
                }
                break;
            }
            if (isDailyQuotaBlocked) break;
            if (!isTransient) {
                if (!(chunk.length > 20 && depth < 2)) {
                    console.error(`${c.red}✖ [Gemini] Calup ${globalChunkIndex + 1}/${totalChunks} eșuat: ${errorMessage}${c.reset}`);
                }
                break;
            }
            if (is5xx) {
                transientAttempts++;
                attemptedKeyStates.clear(); // 503/5xx este o problemă de serviciu, nu un motiv de a epuiza proiectele
                if (transientAttempts < maxTransientAttempts && attempt < maxAttemptsThisPass) {
                    console.log(`${c.yellow}↻ Retry ${transientAttempts}/${maxTransientAttempts} | Backoff activ${c.reset}`);
                    continue;
                }
                console.error(`${c.red}✖ [Gemini] Calup ${globalChunkIndex + 1}/${totalChunks} eșuat după ${transientAttempts} încercări 5xx. Nu îl împart automat.${c.reset}`);
            }
            break;
        }
    }

    if (lastError?.isPermanentQuotaBlock) {
        throw lastError;
    }

    const finalErrorMessage = String(lastError?.message || lastError || '');
    const finalStatus = Number(lastError?.response?.status || 0);
    const finalIs5xx = (finalStatus >= 500 && finalStatus <= 599) || /status code 5\d\d/i.test(finalErrorMessage);
    const finalIsNonRetryable4xx =
        (finalStatus >= 400 && finalStatus <= 499 && finalStatus !== 429) ||
        /Cheie Gemini invalidă \((?:401|403)\)/i.test(finalErrorMessage);
    if (finalIsNonRetryable4xx) {
        // Împărțirea calupului nu poate repara un HTTP 400/401/403:
        // acestea sunt erori de cerere/schemă sau de autentificare, nu de mărimea calupului.
        console.error(`${c.red}✖ [Gemini] Eroare nerecuperabilă HTTP ${finalStatus || finalErrorMessage.match(/\((?:401|403)\)/)?.[0] || '4xx'} pentru calup ${globalChunkIndex + 1}/${totalChunks}; nu împart și nu retrimit automat cererea. Verifică mesajul [Gemini 400] de mai sus.${c.reset}`);
        throw lastError || new Error('Gemini a respins cererea cu o eroare 4xx nerecuperabilă.');
    }
    if (finalIs5xx) {
        // Split-ul nu repară indisponibilitatea serviciului; QA va raporta explicit
        // replicile lipsă, fără multiplicarea apelurilor Gemini pentru aceleași linii.
        return chunk.map(item => ({
            id: item.id,
            text: (isNumericVerbatimCue(item.text) || item.musicOnly) ? String(item.text || '') : ' '
        }));
    }

    if (sawRateLimit429 && (lastError?.isRateLimit429 || /\b429\b/i.test(String(lastError?.message || '')))) {
        if (!deferred429Retry) {
            if (!Array.isArray(keyStates._deferred429Chunks)) keyStates._deferred429Chunks = [];
            const alreadyQueued = keyStates._deferred429Chunks.some(entry =>
                entry.globalChunkIndex === globalChunkIndex &&
                entry.chunkStart === chunkStart &&
                entry.depth === depth &&
                entry.alignmentRepair === alignmentRepair
            );
            if (!alreadyQueued) {
                keyStates._deferred429Chunks.push({
                    chunk: [...chunk], allItems, chunkStart, chunkEnd,
                    previousTranslatedContext: [...(previousTranslatedContext || [])],
                    globalChunkIndex, totalChunks, depth, alignmentRepair
                });
            }
        } else {
            keyStates._deferred429RetryFailedCount = Number(keyStates._deferred429RetryFailedCount || 0) + 1;
        }
        return chunk.map(item => ({
            id: item.id,
            text: (isNumericVerbatimCue(item.text) || item.musicOnly) ? String(item.text || '') : ' '
        }));
    }

    if (chunk.length > 20 && depth < 2) {
        console.log(`${c.yellow}⚠ [Gemini] Împart calupul ${globalChunkIndex + 1} în două părți imediat după eșec...${c.reset}`);

        const middle = Math.floor(chunk.length / 2);
        const first = chunk.slice(0, middle);
        const second = chunk.slice(middle);

        const firstResult = await processChunkWithRetry(first, allItems, chunkStart, chunkStart + middle, previousTranslatedContext, keyStates, globalChunkIndex, totalChunks, depth + 1, alignmentRepair);
        const secondContext = firstResult.slice(-PREVIOUS_TRANSLATION_CONTEXT);
        const secondResult = await processChunkWithRetry(second, allItems, chunkStart + middle, chunkEnd, secondContext, keyStates, globalChunkIndex, totalChunks, depth + 1, alignmentRepair);

        return [...firstResult, ...secondResult];
    }

    console.log(`${c.red}✖ [Gemini] Calupul ${globalChunkIndex + 1} a eșuat definitiv.${c.reset}`);
    throw lastError || new Error('Chunk translation failed.');
}

// ============================================================
// GLOBAL POST-CHECK + TARGETED RETRY
// ============================================================

function isOkOnlySubtitle(text) {
    const clean = String(text || '').replace(/<[^>]+>/g, '').trim();
    // OK/Okay poate fi un răspuns firesc și în română; acceptă una sau mai multe confirmări.
    return /^(?:[-–—\s]*(?:ok|okay)(?:[.!?,…]+)?[-–—\s]*)+$/i.test(clean);
}

async function globalPostCheck(items, translatedById, keyStates, maxPasses = 1) {
    let totalFixed = 0;

    const findSuspicious = () => items.filter(item => {
        if (item.musicOnly) return false;
        if (getIntentionallySuppressedTranslationIds(keyStates).has(String(item.id))) return false;
        const originalClean = isEffectivelyEmptySubtitleText(item.text)
            ? ''
            : String(item.text || '').replace(/<[^>]+>/g, '').trim();
        if (!originalClean || isJunkOrInterjection(item.text)) return false;

        const translated = translatedById[String(item.id)];
        if (isOkOnlySubtitle(translated)) return false;
        const transClean = String(translated || '').replace(/<[^>]+>/g, '').trim();
        if (!transClean) return true;

        return hasUntranslatedEnglish(item.text, translated) ||
            hasCorruptedSubtitleText(translated, item.text) ||
            hasLostExplicitSourceTerm(item.text, translated);
    });

    if (keyStates._primary429CircuitOpen || keyStates._secondaryRecovery429Hold) {
        const remaining = findSuspicious();
        console.log(`${c.yellow}[POST-CHECK] Omisă: circuitul 429 este deschis; nu trimitem traducerile lipsă la Grammar Review.${c.reset}`);
        return { fixed: 0, remaining };
    }

    console.log(`${c.cyan}[POST-CHECK] Verificare contextuală după finalizarea calupurilor...${c.reset}`);
    for (let pass = 1; pass <= maxPasses; pass++) {
        const suspicious = findSuspicious();

        if (!suspicious.length) {
            console.log(`${c.green}[POST-CHECK] Încheiat; ${totalFixed} corectări aplicate.${c.reset}`);
            return { fixed: totalFixed, remaining: [] };
        }

        // Toate replicile ce necesită intervenție sunt trimise împreună la verificarea
        // contextuală. Nu afișăm lista de suspiciuni; logul păstrează doar rezultatul.


        const before = new Map(suspicious.map(item => [
            String(item.id), String(translatedById[String(item.id)] || '')
        ]));
        const reasonById = Object.create(null);
        for (const item of suspicious) {
            const id = String(item.id);
            const current = translatedById[id] || '';
            const reasons = [];
            if (!String(current).trim()) reasons.push('traducere goală');
            if (hasUntranslatedEnglish(item.text, current)) reasons.push('posibil fragment englezesc netradus');
            if (hasCorruptedSubtitleText(current, item.text)) reasons.push('posibil text corupt');
            reasons.push(...getSourceFidelityIssues(item.text, current));
            reasonById[id] = [...new Set(reasons)].join('; ');
        }

        try {
            const reviewResult = await grammarTranslationReview(
                suspicious,
                translatedById,
                keyStates,
                {
                    mode: 'targeted',
                    contextItems: items,
                    reasonById
                }
            );
            totalFixed += Number(reviewResult?.fixed || 0);
        } catch (error) {
            console.log(`${c.yellow}[POST-CHECK] Verificarea grupată nu a putut fi terminată: ${String(error?.message || error).slice(0, 300)}${c.reset}`);
        }

        const remaining = findSuspicious();
        if (!remaining.length) {
            console.log(`${c.green}[POST-CHECK] Încheiat; ${totalFixed} corectări aplicate.${c.reset}`);
            return { fixed: totalFixed, remaining: [] };
        }

        const anyChanged = suspicious.some(item =>
            String(translatedById[String(item.id)] || '') !== before.get(String(item.id))
        );

        // Nu repetăm automat aceeași cerere fără progres: ar adăuga trafic și risc 429.
        if (!anyChanged) return { fixed: totalFixed, remaining };
    }

    const remaining = findSuspicious();
    console.log(`${c.green}[POST-CHECK] Încheiat; ${totalFixed} corectări aplicate.${c.reset}`);
    return { fixed: totalFixed, remaining };
}

// ============================================================
// FILTRU SUPLIMENTAR — GRAMATICĂ + CALITATEA TRADUCERII
// Rulează separat de mecanismul principal și aplică doar corecții certe.
// ============================================================

const GRAMMAR_REVIEW_BATCH_SIZE = 120;
const GRAMMAR_REVIEW_TIMEOUT_MS = 120000;
const GRAMMAR_REVIEW_TIMEOUT_RETRY_MS = 3000;
const GRAMMAR_REVIEW_JSON_RETRY_DELAY_MS = 1200;
const GRAMMAR_REVIEW_JSON_RETRY_LIMIT = 1;
// La eroare JSON se izolează prin split până la replică individuală, dacă este nevoie.
const GRAMMAR_REVIEW_JSON_SPLIT_MIN = 1;

function shouldSplitGrammarReviewBatch(batchLength, isJsonError, message) {
    return batchLength > GRAMMAR_REVIEW_JSON_SPLIT_MIN &&
        (Boolean(isJsonError) || /conținut gol|empty content/i.test(String(message || '')));
}

function cleanPlainTextReviewResponse(rawText) {
    let clean = String(rawText || '').trim();
    clean = clean.replace(/^```(?:text|txt|plaintext)?\s*/i, '').replace(/\s*```$/i, '').trim();
    if (!clean) return '';
    // Dacă modelul a ignorat modul plain-text și a întors JSON/explicații, nu
    // acceptăm un răspuns ambiguu ca traducere.
    if (/^\s*(?:\{|\[)\s*(?:[\"']?id[\"']?\s*:)?/i.test(clean)) return '';
    if (/^(?:traducerea(?: corectată)?|textul corectat|varianta corectată|răspunsul)\s*:/iu.test(clean)) return '';
    return clean;
}

async function grammarTranslationReview(items, translatedById, keyStates, options = {}) {
    if (keyStates._primary429CircuitOpen || keyStates._secondaryRecovery429Hold) {
        if (!keyStates._grammarReview429SkipLogged) {
            keyStates._grammarReview429SkipLogged = true;
            console.log(`${c.yellow}[Grammar Review] Sărită: serviciul Gemini a returnat 429 repetat; nu trimitem loturi goale sau cereri suplimentare.${c.reset}`);
        }
        return { checked: 0, fixed: 0, rejectedQualityReasonsById: Object.create(null) };
    }

    const contextItems = options.contextItems || items;
    const isTargetedReview = options.mode === 'targeted';

    const candidates = items.filter(item => {
        if (item.musicOnly) return false;
        const original = String(item.text || '').replace(/<[^>]+>/g, '').trim();
        const translated = String(translatedById[String(item.id)] || '').replace(/<[^>]+>/g, '').trim();
        if (!original || (!translated && !isTargetedReview)) return false;
        if (isJunkOrInterjection(item.text)) return false;
        if (isOkOnlySubtitle(translated)) return false;
        return true;
    });

    if (!candidates.length) {
        console.log(`${c.green}✔ [Grammar Review] Nu există replici eligibile pentru verificare.${c.reset}`);
        return { checked: 0, fixed: 0 };
    }

    if (isTargetedReview) {
        console.log(`\n${c.cyan}🎯 VERIFICARE PUNCTUALĂ — GRAMATICĂ + TRADUCERE${c.reset}`);
    } else {
        console.log(`\n${c.cyan}📝 VERIFICARE SUPLIMENTARĂ — GRAMATICĂ + TRADUCERE${c.reset}`);
    }
    console.log(`   Verificate: ${candidates.length} replici`);

    const batches = chunkArray(candidates, GRAMMAR_REVIEW_BATCH_SIZE);
    let fixed = 0;
    const verifiedIds = new Set();
    const rejectedQualityReasonsById = Object.create(null);

    const rateLimitRetryQueue = [];
    const rateLimitFailedQueue = [];

    const processGrammarBatch = async (batch, batchIndex, label) => {
        if (keyStates._primary429CircuitOpen || keyStates._secondaryRecovery429Hold) {
            return { success: false, is429: true, halted: true };
        }
        const batchFixedBefore = fixed;

        const payload = batch.map(item => {
            const index = getFastItemIndex(contextItems, item.id);
            const previous = index > 0 ? contextItems[index - 1] : null;
            const next = index >= 0 && index < contextItems.length - 1 ? contextItems[index + 1] : null;

            return {
                id: item.id,
                original: item.text,
                translation: translatedById[String(item.id)],
                context_anterior_en: previous ? `[${previous.id}] ${previous.text}` : '(niciunul)',
                context_urmator_en: next ? `[${next.id}] ${next.text}` : '(niciunul)',
                context_anterior_ro: previous ? `[${previous.id}] ${translatedById[String(previous.id)] || ''}` : '(niciunul)',
                context_urmator_ro: next ? `[${next.id}] ${translatedById[String(next.id)] || ''}` : '(niciunul)',
                avertisment_semantic: [
                    getSourceFidelityIssues(item.text, translatedById[String(item.id)] || '').join('; '),
                    options.reasonById ? (options.reasonById[String(item.id)] || '') : ''
                ].filter(Boolean).join('; ')
            };
        });

        const prompt = `Ești un editor profesionist de subtitrări ENGLEZĂ → ROMÂNĂ. Revizuiești traducerea existentă, nu o retraducești automat.

SCOP
Returnează numai corecțiile pentru greșeli clare și demonstrabile de sens, gramatică, vocabular, ortografie sau naturalețe românească. Dacă traducerea este deja corectă și suficient de naturală, nu o modifica. Nu face rescrieri doar din preferință stilistică.

VERIFICĂ ÎN ORDINE
1. Compară ORIGINALUL, traducerea și contextul imediat înainte/după. Verifică sensul complet, expresiile idiomatice, cine face acțiunea și cine/ce o primește.
2. Verifică relațiile gramaticale, nu doar prezența cuvintelor: obiect direct versus loc, prepoziții, pronume/clitice, posesie, negație, timp, persoană, gen și număr. De exemplu, pentru EN “the sound that dries my vagina”, „îmi usucă vaginul” păstrează relația de obiect direct; „mă usucă în vagin” schimbă sensul.
3. Păstrează termenii expliciți și sensul direct când sursa îi folosește. Nu îi înlocui cu eufemisme și nu transforma intensificatorii/înjurăturile în obiecte, acțiuni sau insulte diferite.
4. Păstrează singularul/pluralul și referentul. De exemplu, “a hat” nu trebuie tradus „căciuli”. Nu adăuga diminutive precum „căciuliță” dacă sursa nu exprimă micime, afecțiune sau diminutiv.
5. Repară româna nenaturală sau calchiată numai dacă poți stabili din original și context ce înseamnă sursa și poți produce o variantă clar mai corectă. Verifică și cuvinte tăiate, forme inexistente, clitice greșite, diacritice, acorduri și fragmente englezești rămase.
6. Păstrează tonul personajului, inclusiv vulgaritatea, sarcasmul și colocvialismul. Nu infantiliza și nu formaliza dialogul.
7. VERSURI MUZICALE EXCLUSE: textul dintre marcatorii muzicali este înlocuit înaintea verificării cu tokenuri tehnice de forma ZXQKEEPSONG...QXZ și va fi eliminat complet din SRT-ul final. Copiază fiecare token identic, o singură dată, în poziția lui; NU îl traduce, nu îl șterge, nu îl modifica și nu reconstrui versurile ascunse. Dacă replica are și dialog în afara tokenului, corectează numai dialogul și păstrează tokenurile identice. Textul protejat nu trebuie să apară în rezultat.
8. Dacă obiectul conține „avertisment_semantic”, verifică explicit problema indicată. Nu considera problema rezolvată doar fiindcă un anumit cuvânt apare în traducere; verifică și relația de sens.
9. Dacă avertismentul menționează un conector repetat între două subtitrări consecutive, compară ambele originale și ambele traduceri din context. Păstrează conectorul în fragmentul al cărui original îl conține. Dacă originalul fragmentului curent NU începe/nu se termină cu acel conector, dar traducerea îl adaugă la limită, elimină doar conectorul adăugat inutil din replica curentă; nu șterge conectorul justificat de următorul/precedentul original. Dacă dovezile nu sunt clare, nu rescrie.
10. Dacă avertismentul indică un fragment englezesc netradus, o secvență englezească deteriorată sau un text corupt și originalul/contextul permit stabilirea sensului, corectează efectiv fragmentul în română. Nu lăsa secvența deteriorată în text și nu omite corectura doar pentru că restul replicii este românește. Dacă semnalul este un fals pozitiv și formularea românească transmite deja sensul originalului, păstreaz-o.
11. Dacă avertismentul indică aceeași traducere românească pentru două originale englezești diferite, compară separat sensul fiecărui original cu traducerea lui și folosește contextul ambelor replici. Nu păstra automat traducerea duplicată, dar nici nu schimba o replică doar pentru a evita repetiția. Corectează doar ID-ul/ID-urile pentru care există o nepotrivire demonstrabilă; nu muta textul între ID-uri.
12. Dacă avertismentul indică o posibilă suprapunere de sens între două subtitrări consecutive, verifică dacă originalul englezesc al primei replici continuă în următorul ID și dacă traducerea română a primei replici a anticipat deja o expresie care aparține semantic următoarei. Dacă prima traducere adaugă sensul următoarei replici, rescrie numai ID-ul pentru care surplusul este demonstrabil, astfel încât fiecare ID să exprime doar conținutul justificat de propriul original și context. Nu elimina o repetiție firească, nu muta text între ID-uri și nu forța diferențe stilistice când ambele traduceri sunt valide.

REGULĂ DE PRUDENȚĂ
Nu schimba o replică validă doar ca să sune diferit. Dacă există mai multe variante plauzibile și nu poți demonstra care este necesară, păstrează traducerea. Returnează doar câmpul „text” pentru ID-urile realmente corectate; nu modifica ID-uri și nu atinge contextul.
${isTargetedReview && batch.some(entry => !String(translatedById[String(entry.id)] || '').trim()) ? '\nIMPORTANT: dacă un obiect are câmpul „translation” gol, nu există text de păstrat pentru acel ID. Tradu acel original în română pe baza contextului și returnează textul pentru acel ID; nu-l omite.\n' : ''}
DATE DE VERIFICAT:
Fiecare obiect include id, original, translation, context_anterior_en, context_urmator_en, context_anterior_ro, context_urmator_ro și, uneori, avertisment_semantic. Contextul este doar pentru înțelegere; corectează numai replica curentă.
${JSON.stringify(payload, null, 2)}

Returnează DOAR JSON valid:
[
  {"id": 123, "text": "traducerea corectată"}
]
Pentru ID-urile fără o greșeală clară, returnează un array gol: [].`;

        let lastJsonError = null;

        // JSON-ul Gemini poate fi invalid ocazional chiar dacă promptul cere
        // explicit JSON valid. Facem un retry pe același calup; dacă răspunsul
        // rămâne invalid, îl împărțim repetat până la replici individuale.
        // Dimensiunea normală rămâne 120; split-ul apare doar la eroare de format
        // și evită ca un singur răspuns invalid să lase neverificat tot grupul.
        for (let jsonAttempt = 0; jsonAttempt <= GRAMMAR_REVIEW_JSON_RETRY_LIMIT; jsonAttempt++) {
            try {
                if (jsonAttempt > 0) {
                    console.log(`${c.yellow}↻ [Grammar Review] JSON invalid la ${batch.length} replici; retry ${jsonAttempt}/${GRAMMAR_REVIEW_JSON_RETRY_LIMIT}...${c.reset}`);
                    await sleep(GRAMMAR_REVIEW_JSON_RETRY_DELAY_MS);
                }

                const requestPrompt = jsonAttempt > 0
                    ? `${prompt}\n\nRETRY TEHNIC: Returnează DOAR JSON valid, fără markdown sau explicații. Format exact: [{\"id\":123,\"text\":\"...\"}]. Pentru nicio corecție returnează exact []. Nu modifica ID-urile. Escapă toate ghilimelele interne din text.`
                    : prompt;
                const raw = await callGeminiWithKeyRotation(requestPrompt, keyStates, {
                    timeout: GRAMMAR_REVIEW_TIMEOUT_MS,
                    requestLabel: `Grammar Review — ${label || `calup ${batchIndex + 1}/${batches.length}`}`,
                    // Folosim MEDIUM și pentru Grammar Review, în acord cu nivelul general de gândire.
                    thinkingLevel: 'MEDIUM',
                    responseSchema: {
                        type: 'ARRAY',
                        items: {
                            type: 'OBJECT',
                            properties: {
                                id: { type: 'INTEGER' },
                                text: { type: 'STRING' }
                            },
                            required: ['id', 'text'],
                            propertyOrdering: ['id', 'text']
                        }
                    }
                });
                const parsed = safeJsonParse(raw);
                const parsedDict = normalizeTranslationPayload(parsed);

                for (const checkedItem of batch) verifiedIds.add(String(checkedItem.id));

                for (const item of batch) {
                    const id = String(item.id);
                const candidateRaw = parsedDict[id];
                if (candidateRaw == null) continue;

                const current = formatSubtitleLine(String(translatedById[id] || ''));
                const candidate = formatSubtitleLine(String(candidateRaw || ''));

                if (!candidate || candidate === current) continue;
                if (!hasAllProtectedMusicTokens(item, candidate)) continue;

                // Filtrul suplimentar poate aplica doar o corecție care rămâne
                // compatibilă cu verificările deja existente.
                if (hasUntranslatedEnglish(item.text, candidate) ||
                    hasCorruptedSubtitleText(candidate, item.text) ||
                    hasLostExplicitSourceTerm(item.text, candidate)) {
                    // Corectura suspectă este respinsă fără a încărca logul cu detalii per replică.
                    continue;
                }

                // Nu acceptăm o corectură AI dacă ea introduce o problemă lingvistică
                // sau semantică de înaltă încredere pe care versiunea anterioară nu o avea.
                const previousQualityReasons = collectQualityReviewReasons(
                    item, current, contextItems, translatedById
                );
                const candidateQualityReasons = collectQualityReviewReasons(
                    item, candidate, contextItems, translatedById
                );
                const newlyIntroducedQualityReasons = candidateQualityReasons.filter(
                    reason => !previousQualityReasons.includes(reason)
                );
                if (newlyIntroducedQualityReasons.length) {
                    rejectedQualityReasonsById[id] = [...new Set([
                        ...(rejectedQualityReasonsById[id] || []),
                        ...newlyIntroducedQualityReasons
                    ])];
                    // Corectura care introduce un semnal nou este respinsă; raportăm doar totalul corecturilor acceptate.
                    continue;
                }

                translatedById[id] = candidate;
                fixed++;
                }

                // IMPORTANT: dacă răspunsul JSON a fost valid și am procesat calupul,
                // calupul este REUȘIT. Nu lăsăm bucla de retry să cadă ulterior în
                // fallback-ul „eroare necunoscută” și să dubleze contorul checked.
                const batchFixed = fixed - batchFixedBefore;
                console.log(`${c.green}✔ [Grammar Review] Calup ${batchIndex + 1}/${batches.length}: ${batchFixed} corectate${c.reset}`);
                return { success: true, is429: false };
            } catch (error) {
                lastJsonError = error;
                const message = String(error?.message || '');
                const is429 = error?.isRateLimit429 === true || /429/.test(message);
                const isTimeout = error?.code === 'ECONNABORTED' ||
                    error?.code === 'ETIMEDOUT' ||
                    /timeout|timed out/i.test(message);

                // 429 și timeout-ul au propriul mecanism de retry/split.
                // Nu le tratăm ca eroare JSON.
                if (is429 || isTimeout) {
                    if (isTimeout && batch.length > 20) {
                        const middle = Math.ceil(batch.length / 2);
                        const left = batch.slice(0, middle);
                        const right = batch.slice(middle);

                        console.log(`${c.yellow}⚠ [Grammar Review] Timeout la ${batch.length} replici; împart calupul în ${left.length}+${right.length} și reîncerc...${c.reset}`);
                        await sleep(GRAMMAR_REVIEW_TIMEOUT_RETRY_MS);

                        const leftResult = await processGrammarBatch(
                            left,
                            batchIndex,
                            `${label} — partea 1/${2}`
                        );
                        const rightResult = await processGrammarBatch(
                            right,
                            batchIndex,
                            `${label} — partea 2/${2}`
                        );

                        return {
                            success: leftResult.success && rightResult.success,
                            is429: leftResult.is429 || rightResult.is429
                        };
                    }

                    // Grammar Review trebuie să activeze aceeași poartă globală
                    // folosită de traducerea principală, nu doar pauza cheii curente.
                    if (is429) {
                        const cooldownMs = Number(error?.retryAfterMs) || 30000;
                        register429(keyStates, cooldownMs);
                        const poolSnapshot = getGeminiPoolAvailability(keyStates);
                        const noProjectsLeft = poolSnapshot.available.length === 0 &&
                            poolSnapshot.temporarilyPaused.length === 0;
                        if (noProjectsLeft) {
                            keyStates._secondaryRecovery429Hold = true;
                            keyStates._emptyRecoveryIndividualRetriesDisabled = true;
                            return { success: false, is429: true, halted: true };
                        }

                        // Rotația a primit 429, dar mai există proiecte eligibile sau
                        // proiecte temporar în cooldown. Nu blocăm Grammar Review:
                        // calupul rămâne în rateLimitRetryQueue pentru o rundă coordonată.
                        keyStates._secondaryRecovery429Hold = false;
                        keyStates._emptyRecoveryIndividualRetriesDisabled = false;
                        return { success: false, is429: true, halted: false };
                    }

                    // Timeout pe calup mic: păstrăm comportamentul existent.
                    console.log(`${c.yellow}⚠ [Grammar Review] Calupul ${batchIndex + 1} a expirat și nu mai poate fi împărțit.${c.reset}`);
                    return { success: false, is429: false };
                }

                const errorStatus = Number(error?.response?.status || 0);
                const is5xx = (errorStatus >= 500 && errorStatus <= 599) || /status code 5\d\d/i.test(message);
                if (is5xx) {
                    const statusLabel = errorStatus || message.match(/5\d\d/)?.[0] || '5xx';
                    console.log(`${c.yellow}⚠ [Grammar Review] Gemini ${statusLabel}; calupul rămâne neschimbat. Eroarea nu este tratată ca JSON invalid.${c.reset}`);
                    return { success: false, is429: false };
                }

                const isJsonError = /JSON Parse failed|Unexpected token|Unexpected end of JSON|Expected ',' or '}'|Expected property name/i.test(message);

                // Prima eroare JSON/conținut gol: retry pe același calup, cu prompt
                // explicit de reparare. Nu împărțim încă pentru a păstra viteza normală.
                if ((isJsonError || /conținut gol|empty content/i.test(message)) &&
                    jsonAttempt < GRAMMAR_REVIEW_JSON_RETRY_LIMIT) {
                    lastJsonError = error;
                    continue;
                }

                // După retry-ul JSON, împărțim numai dacă răspunsul rămâne invalid
                // sau gol. Erorile API nelegate de format nu declanșează split
                // suplimentar; dacă un singleton tot nu produce JSON valid, îl
                // lăsăm explicit neverificat în raportul final.
                // Dacă JSON-ul este invalid chiar și la o singură replică, nu
                // repetăm la nesfârșit aceeași formă. Cerem o singură dată text simplu,
                // fără responseSchema, apoi folosim aceleași controale de fidelitate
                // și de regresie ca la o corectură JSON. Dacă fallback-ul e ambiguu,
                // Dacă fallback-ul eșuează, traducerea curentă se păstrează; nu se emite raport per ID.
                if (isJsonError && batch.length === 1 && jsonAttempt >= GRAMMAR_REVIEW_JSON_RETRY_LIMIT) {
                    const item = batch[0];
                    const id = String(item.id);
                    const current = formatSubtitleLine(String(translatedById[id] || ''));
                    const singlePayload = payload.find(entry => String(entry.id) === id) || payload[0];
                    console.log(`${c.yellow}↻ [Grammar Review] JSON invalid la o singură replică (ID ${id}); încerc o singură rezervă text simplu...${c.reset}`);
                    try {
                        const fallbackPrompt = `Ești un corector profesionist de subtitrări ENGLEZĂ → ROMÂNĂ. Verifică DOAR replica descrisă mai jos, comparând originalul, traducerea curentă și contextul.

Corectează numai dacă există o greșeală clară de sens, gramatică, vocabular sau ortografie. Dacă traducerea este deja corectă, returnează exact traducerea curentă. Păstrează sensul, persoana, timpul și punctuația justificată de context. Nu inventa text.

DATE:
${JSON.stringify(singlePayload, null, 2)}

Returnează DOAR textul final al replicii românești, fără JSON, fără markdown, fără ghilimele adăugate în jurul întregii replici și fără explicații.`;
                        const fallbackRaw = await callGeminiWithKeyRotation(fallbackPrompt, keyStates, {
                            timeout: GRAMMAR_REVIEW_TIMEOUT_MS,
                            requestLabel: `Grammar Review — ${label || `calup ${batchIndex + 1}/${batches.length}`} — fallback text`,
                            thinkingLevel: 'MEDIUM',
                            plainText: true
                        });
                        const fallbackText = cleanPlainTextReviewResponse(fallbackRaw);
                        const candidate = formatSubtitleLine(fallbackText);
                        if (!candidate) throw new Error('răspunsul plain-text a fost gol, JSON sau conținea explicații');

                        if (candidate !== current) {
                            if (!hasAllProtectedMusicTokens(item, candidate)) {
                                throw new Error('corectura plain-text a modificat un token de versuri muzicale protejat');
                            }
                            if (hasUntranslatedEnglish(item.text, candidate) ||
                                hasCorruptedSubtitleText(candidate, item.text) ||
                                hasLostExplicitSourceTerm(item.text, candidate)) {
                                throw new Error('corectura plain-text nu a trecut verificările existente de fidelitate');
                            }
                            const previousQualityReasons = collectQualityReviewReasons(item, current, contextItems, translatedById);
                            const candidateQualityReasons = collectQualityReviewReasons(item, candidate, contextItems, translatedById);
                            const newlyIntroducedQualityReasons = candidateQualityReasons.filter(reason => !previousQualityReasons.includes(reason));
                            if (newlyIntroducedQualityReasons.length) {
                                rejectedQualityReasonsById[id] = [...new Set([...(rejectedQualityReasonsById[id] || []), ...newlyIntroducedQualityReasons])];
                                throw new Error(`corectura a introdus un semnal nou: ${newlyIntroducedQualityReasons.join('; ')}`);
                            }
                            translatedById[id] = candidate;
                            fixed++;
                            console.log(`${c.green}✔ [Grammar Review] ID ${id}: fallback text simplu acceptat după validare.${c.reset}`);
                        } else {
                            console.log(`${c.green}✔ [Grammar Review] ID ${id}: fallback text simplu confirmă textul existent; nicio modificare necesară.${c.reset}`);
                        }
                        verifiedIds.add(id);
                        return { success: true, is429: false };
                    } catch (fallbackError) {
                        // Erorile 429 ale fallback-ului reintră în coada coordonată;
                        // alte erori păstrează traducerea existentă și evită loguri per ID.
                        const fallbackMessage = String(fallbackError?.message || fallbackError);
                        const fallbackIs429 = fallbackError?.isRateLimit429 === true || /\b429\b/.test(fallbackMessage);
                        if (fallbackIs429) {
                            lastJsonError = fallbackError;
                            // Intră în același handler de 429 al calupului.
                            const cooldownMs = Number(fallbackError?.retryAfterMs) || 30000;
                            register429(keyStates, cooldownMs);
                            const poolSnapshot = getGeminiPoolAvailability(keyStates);
                            const noProjectsLeft = poolSnapshot.available.length === 0 &&
                                poolSnapshot.temporarilyPaused.length === 0;
                            if (noProjectsLeft) {
                                keyStates._secondaryRecovery429Hold = true;
                                keyStates._emptyRecoveryIndividualRetriesDisabled = true;
                                return { success: false, is429: true, halted: true };
                            }
                            keyStates._secondaryRecovery429Hold = false;
                            keyStates._emptyRecoveryIndividualRetriesDisabled = false;
                            return { success: false, is429: true, halted: false };
                        }
                        return { success: false, is429: false };
                    }
                }

                if (shouldSplitGrammarReviewBatch(batch.length, isJsonError, message)) {
                    const middle = Math.ceil(batch.length / 2);
                    const left = batch.slice(0, middle);
                    const right = batch.slice(middle);

                    console.log(`${c.yellow}⚠ [Grammar Review] Calupul ${batch.length} nu a putut fi returnat ca JSON; împart în ${left.length}+${right.length} și reîncerc separat...${c.reset}`);

                    const leftResult = await processGrammarBatch(
                        left,
                        batchIndex,
                        `${label} — JSON split 1/${2}`
                    );
                    const rightResult = await processGrammarBatch(
                        right,
                        batchIndex,
                        `${label} — JSON split 2/${2}`
                    );

                    return {
                        success: leftResult.success && rightResult.success,
                        is429: leftResult.is429 || rightResult.is429
                    };
                }

                console.log(`${c.yellow}⚠ [Grammar Review] Calupul ${batchIndex + 1} nu a putut fi verificat: ${message || 'eroare necunoscută'}${c.reset}`);
                return { success: false, is429: false };
            }
        }

        // Protecție teoretică; bucla de mai sus fie returnează, fie reia retry-ul.
        console.log(`${c.yellow}⚠ [Grammar Review] Calupul ${batchIndex + 1} a eșuat: ${lastJsonError?.message || 'eroare necunoscută'}${c.reset}`);
        return { success: false, is429: false };
    };

    // Prima trecere: dacă un calup primește 429, nu îl abandonăm definitiv.
    // Îl punem la coadă și îl reîncercăm după ce terminăm toate calupurile normale.
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        if (keyStates._primary429CircuitOpen || keyStates._secondaryRecovery429Hold) break;
        const result = await processGrammarBatch(
            batch,
            batchIndex,
            `Calup ${batchIndex + 1}/${batches.length}`
        );

        if (result.is429 && !result.halted) {
            rateLimitRetryQueue.push({ batch, batchIndex });
        }
    }

    // Maximum 2 reîncercări suplimentare DOAR pentru calupurile care au eșuat cu 429.
    // Nu modificăm aici logica 429 a traducerii principale sau a altor etape.
    for (let retryRound = 1; retryRound <= 2 && rateLimitRetryQueue.length && !keyStates._primary429CircuitOpen && !keyStates._secondaryRecovery429Hold; retryRound++) {
        const retryPool = getGeminiPoolAvailability(keyStates);
        if (!retryPool.available.length && retryPool.temporarilyPaused.length) {
            const waitStartedAt = Date.now();
            const projectWaitMs = getMinimumTransientPoolCooldownMs(keyStates, waitStartedAt, true);
            const globalUntil = Math.max(
                Number(geminiRequestControl.cooldownUntil || 0),
                Number(geminiRequestControl.global429PauseUntil || 0),
                Number(getGlobal429Until(keyStates) || 0)
            );
            const waitMs = Math.max(projectWaitMs, globalUntil - waitStartedAt);
            if (waitMs > 0) {
                console.log(`${c.yellow}[Grammar Review] Toate proiectele rămase sunt temporar în cooldown; aștept ${Math.ceil(waitMs / 1000)}s înainte de runda ${retryRound}/2.${c.reset}`);
                await sleep(Math.min(waitMs, 120000) + 250);
            }
        }
        const pending = rateLimitRetryQueue.splice(0);
        console.log(`${c.cyan}🔄 [Grammar Review] Reîncerc 429: ${pending.length} calupuri (runda ${retryRound}/2)...${c.reset}`);

        for (const queued of pending) {
            const result = await processGrammarBatch(
                queued.batch,
                queued.batchIndex,
                `Reîncercare 429 — Calup ${queued.batchIndex + 1}/${batches.length} (runda ${retryRound}/2)`
            );

            if (result.is429) {
                if (retryRound < 2) {
                    rateLimitRetryQueue.push(queued);
                } else {
                    // Nu pierdem evidența eșecurilor din ultima rundă.
                    rateLimitFailedQueue.push(queued);
                }
            }
        }
    }

    // Nu construim liste de ID-uri pentru raportarea la final a replicilor
    // neverificate. Erorile API și limitările 429 rămân vizibile în log în momentul apariției.
    const checked = verifiedIds.size;
    console.log(`${c.green}✔ [Grammar Review] Verificarea s-a încheiat; ${fixed} corectări aplicate.${c.reset}`);
    return { checked, fixed, rejectedQualityReasonsById };
}

// ============================================================
// MICRO-CHECK LOCAL — ORTOGRAFIE + GRAMATICĂ EVIDENTĂ
// Nu folosește Gemini. Aplică doar corecții cu încredere foarte mare
// și marchează restul pentru o verificare punctuală.
// ============================================================

const LOCAL_GRAMMAR_FIXES = [
    // Greșeli reale observate în verificări manuale ale subtitrărilor.
    [/\brenumererațiile\b/gi, 'remunerațiile'],
    [/\brenumererație\b/gi, 'remunerație'],
    [/\brenumererația\b/gi, 'remunerația'],
    [/\brenumererației\b/gi, 'remunerației'],
    [/\brenumererațiilor\b/gi, 'remunerațiilor'],
    [/\brenumererați\b/gi, 'remunerați'],
    [/\brenumererate\b/gi, 'remunerate'],
    [/(?<![A-Za-zĂÂÎȘȚăâîșț])renumerată(?![A-Za-zĂÂÎȘȚăâîșț])/gi, 'remunerată'],
    [/\brenumerat\b/gi, 'remunerat'],
    [/\brenumerare\b/gi, 'remunerare'],
    [/\brenumerarea\b/gi, 'remunerarea'],
    [/\brenumerării\b/gi, 'remunerării'],
    [/\brenumerările\b/gi, 'remunerările'],
    [/\brenumerațiile\b/gi, 'remunerațiile'],
    [/\brenumerație\b/gi, 'remunerație'],
    [/\brenumerația\b/gi, 'remunerația'],
    [/\brenumerației\b/gi, 'remunerației'],
    [/\brenumerațiilor\b/gi, 'remunerațiilor'],
    [/\brenumerați\b/gi, 'remunerați'],
    [/\brenumerate\b/gi, 'remunerate'],
    [/\bsugist\b/gi, 'sugi'],

    // Corecții locale suplimentare cu încredere foarte mare, validate în QA.
    [/\bdeciizi\b/gi, 'decizi'],
    [/\bco\s+cerul\b/gi, 'că cerul'],
    [/\bAlelea\b/gi, 'Alea'],
    [/\bn-mai\b/gi, 'nu mai'],
    [/\bBine,,/gi, 'Bine,'],
    [/\bpropria\s+noastre\b/gi, 'propria noastră'],
    [/\binnascute\b/gi, 'înnăscute'],
    [/\binnascuta\b/gi, 'înnăscută'],
    [/\binnascut\b/gi, 'înnăscut'],
    [/\binnascuti\b/gi, 'înnăscuți'],
    [/(?<![\p{L}])ți-a\s+pasat\b/iu, 'ți-a păsat'],
    // Corectări ortografice de încredere ridicată observate în verificarea v121.
    [/(?<![\p{L}])resuscitatăm(?![\p{L}])/giu, 'resuscităm'],
    [/(?<![\p{L}])nimani(?![\p{L}])/giu, 'nimeni'],
    [/(?<![\p{L}])lasă-mi-te(?![\p{L}])/giu, 'lasă-mă'],
    [/\bnite\b/giu, 'niște'],
    [/\bnare(?=\s+(?:niciun(?:ul|a)?|nicio|nimic|sens|rost)\b)/giu, 'n-are']
];

function applyLocalGrammarDeterministicFixes(text) {
    let result = String(text || '');
    for (const [pattern, replacement] of LOCAL_GRAMMAR_FIXES) {
        result = result.replace(pattern, match => {
            if (match === match.toUpperCase()) return replacement.toUpperCase();
            if (match[0] === match[0].toUpperCase()) {
                return replacement.charAt(0).toUpperCase() + replacement.slice(1);
            }
            return replacement;
        });
    }
    return result;
}

function detectLocalGrammarReviewReasons(text) {
    const clean = String(text || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!clean) return [];

    const reasons = [];

    // Semnale pentru deformări și construcții românești cu risc mare.
    // Nu rescriem automat: sunt trimise la verificare AI numai replicile marcate.
    const highConfidenceRomanianQualityGuards = [
        { pattern: /(?<![\p{L}])introm(?![\p{L}])/iu, message: 'posibil cuvânt trunchiat/inexistent „introm”' },
        { pattern: /(?<![\p{L}])eau\s+(?:de\s+)?\d+(?:\s*,\s*\d+)?(?![\p{L}])/iu, message: 'posibil cuvânt trunchiat înaintea unui număr („eau de 12, 15”)' },
        { pattern: /(?<![\p{L}])necesiți(?![\p{L}])/iu, message: 'formă verbală românească suspectă „necesiți”' },
        { pattern: /(?<![\p{L}])flori[-\s]+soarelui(?![\p{L}])/iu, message: 'posibil calc/declinare greșită „flori-soarelui”' },
        { pattern: /(?<![\p{L}])modalitate\s+noi\s+\p{L}+(?![\p{L}])/iu, message: 'construcție gramaticală suspectă după „modalitate noi”' },
        { pattern: /(?<![\p{L}])din\s+cauz[ăa]\s+la(?![\p{L}])/iu, message: 'construcție gramaticală suspectă „din cauză la”; necesită verificare contextuală' },
        { pattern: /(?<![\p{L}])din\s+cauza\s+(?:voastră|voștri|voastre),?\s*a\s+doi(?![\p{L}])/iu, message: 'construcție suspectă „din cauza voastră, a doi”' },
        { pattern: /(?<![\p{L}])lăsați-mi\s+(?:echipa|grupul|echipajul|oamenii|soldații|soldatii)\s+să(?![\p{L}])/iu, message: 'posibilă ordine greșită a pronumelui în construcția „lăsați-mi ... să”' },
        { pattern: /(?<![\p{L}])(?:lucrura|acesa|întregă|nite|introm|nimani|resuscitatăm)(?![\p{L}])/iu, message: 'posibilă deformare/greșeală ortografică' },
        { pattern: /(?<![\p{L}])lasă-mi-te(?![\p{L}])/iu, message: 'succesiune de clitice agramaticală „lasă-mi-te”' },
        { pattern: /(?<![\p{L}])strisoarea(?![\p{L}])/iu, message: 'posibilă deformare ortografică „strisoarea”' },
        { pattern: /(?<![\p{L}])ne-am\s+lipsit(?![\p{L}])/iu, message: 'formulare suspectă „ne-am lipsit”' },
        { pattern: /(?<![\p{L}])le\s+mai\s+te\s+ui(?:ți|ti)(?![\p{L}])/iu, message: 'succesiune de pronume suspectă „le mai te uiți”' },
        { pattern: /(?<![\p{L}])(?:așa|asa)\s+and\s+(?:gândeam|gandeam)(?![\p{L}])/iu, message: 'fragment englezesc netradus „Așa and gândeam”' },
        { pattern: /(?<![\p{L}])pot\s+să\s+(?:vorbim|mergem|facem|avem|plecăm|plecam|vedem|spunem|știm|stim|fim)(?![\p{L}])/iu, message: 'nepotrivire de persoană după „pot să”' },
        { pattern: /(?<![\p{L}])ar\s+trebui(?:\s+măcar)?\s+(?:le|îi|mi|ne|vă|te|mă)\s+\p{L}+/iu, message: 'posibil „să” lipsă în construcția „ar trebui ...”' },
        { pattern: /(?<![\p{L}])nu\s+ești\s+(?:nici\s+)?părere\s+de\s+rău(?![\p{L}])/iu, message: 'expresie idiomatică agramaticală „nu ești părere de rău”' },

        // Semnale generale (nu doar cazuri izolate). Nu corectează automat:
        // marchează replica pentru singura verificare AI punctuală deja existentă.
        { pattern: /(?<![\p{L}])(?:stiu|stii|stiti|inteleg|intelegi|multumesc|multumim|sunteti|aveti|puteti|vreti|inca|dupa|asa|pana|cand|tara|romana)(?![\p{L}])/iu, message: 'cuvânt românesc probabil scris fără diacritice' },
        { pattern: /(?:(?<![\p{L}'’-])in|(?:^|[.!?…]\s+)In)\s+\p{Ll}/u, message: 'cuvântul „in” este probabil „în” scris fără diacritică (sau engleză rămasă)' },
        { pattern: /(?<![\p{L}])(?:face|fac|făcea|facă)\s+sens(?![\p{L}])/iu, message: 'calc „face sens” (în română: „are sens”)' },
        { pattern: /(?<![\p{L}])realiz\p{L}*\s+că(?![\p{L}])/iu, message: 'calc „a realiza că” (în română: „a-și da seama că”)' },
        { pattern: /(?<![\p{L}])în\s+ordine\s+să(?![\p{L}])/iu, message: 'calc „în ordine să” (în română: „ca să” / „pentru a”)' },
        { pattern: /(?<![\p{L}])\p{L}+\/ă(?![\p{L}])|\(ă\)/iu, message: 'formă de gen dublă cu slash/paranteză; alege forma potrivită din context' }
    ];
    for (const guard of highConfidenceRomanianQualityGuards) {
        if (guard.pattern.test(clean)) reasons.push(guard.message);
    }

    // Registru amestecat în aceeași replică („dumneavoastră” + „tu/ești/te/ți”).
    if (/(?<![\p{L}])(?:dumneavoastră|dvs|dumneata)(?![\p{L}])/iu.test(clean) &&
        /(?<![\p{L}])(?:tu|ești|tău|tale|tine|ți|te)(?![\p{L}])/iu.test(clean)) {
        reasons.push('registru amestecat în aceeași replică (dumneavoastră și tu)');
    }

    // Filtrul general de cuvinte repetate este dezactivat deliberat.
    // Repetițiile din dialog și versuri pot fi firești; nu declanșăm
    // verificare gramaticală/AI doar pentru că un cuvânt apare de două ori.

    // Construcții de clitic evident suspecte, pe care Grammar Review deja știe
    // să le analizeze, dar care merită o verificare punctuală atunci când apar.
    if (/\baș-o\b/i.test(clean)) reasons.push('clitic suspect „aș-o”');
    if (/\bnu\s+ți-pasă\b/i.test(clean)) reasons.push('clitic suspect „nu ți-pasă”');
    if (/\buită-ce-mi\b/i.test(clean)) reasons.push('clitic suspect „uită-ce-mi”');
    if (/(?:^|\s)(?:să|sa)\s+mi\s+facă\b/i.test(clean)) reasons.push('clitic suspect „să mi facă”');

    // Calcuri/construcții observate în QA manual. Sunt DOAR semnale: nu sunt
    // modificate automat fără comparație cu originalul și contextul.
    if (/(?:^|[^\p{L}])(?:însuși|insusi|insuşi)\s+semnalele(?:$|[^\p{L}])/iu.test(clean)) reasons.push('acord suspect „însuși semnalele”');
    if (/\bnici\s+mai\s+mult\s+decât\s+este\s+el\b/i.test(clean)) reasons.push('construcție comparativă suspectă');

    // Detectare țintită pentru cuvinte englezești de conținut care pot rămâne
    // integrate într-o propoziție românească și pot scăpa detectorului global.
    // Lista este intenționat scurtă și conservatoare pentru a evita nume proprii
    // sau împrumuturi uzuale din română.
    const highConfidenceEnglish = new Set([
        'upheaval', 'innate', 'indictment', 'disregard', 'however', 'although',
        'meanwhile', 'witness', 'threat', 'helpless', 'sudden', 'footage',
        'outcome', 'warning', 'breach', 'device', 'evidence', 'outnumbered'
    ]);
    const englishIntegrated = clean.match(/[A-Za-z]+/g) || [];
    const englishHits = englishIntegrated.filter(word => highConfidenceEnglish.has(word.toLowerCase()));
    for (const word of [...new Set(englishHits.map(w => w.toLowerCase()))]) {
        reasons.push(`cuvânt englezesc integrat „${word}”`);
    }

    return reasons;
}

const itemsIndexCache = new WeakMap();
function getFastItemIndex(itemsArray, id) {
    if (!Array.isArray(itemsArray)) return -1;
    let indexMap = itemsIndexCache.get(itemsArray);
    if (!indexMap) {
        indexMap = new Map();
        for (let i = 0; i < itemsArray.length; i++) {
            const key = String(itemsArray[i].id);
            // findIndex întoarce prima potrivire și în cazul unor ID-uri duplicate.
            if (!indexMap.has(key)) indexMap.set(key, i);
        }
        itemsIndexCache.set(itemsArray, indexMap);
    }
    const found = indexMap.get(String(id));
    return found !== undefined ? found : -1;
}

function detectSourceAwareQualityReviewReasons(item, translation, contextItems, translatedById) {
    const source = String(item?.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const target = String(translation || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!source || !target || isJunkOrInterjection(item?.text)) return [];

    const reasons = [];
    // Raport de lungime: româna este de obicei cu 10–30% mai lungă decât engleza.
    // Praguri largi, doar pentru abateri evidente (omisiune sau adăugare de sens).
    const sourceLetterCount = source.replace(/[^\p{L}]/gu, '').length;
    const targetLetterCount = target.replace(/[^\p{L}]/gu, '').length;
    if (sourceLetterCount >= 30 && targetLetterCount < sourceLetterCount * 0.45) {
        reasons.push('traducerea este mult mai scurtă decât originalul (posibilă omisiune de sens)');
    }
    if (targetLetterCount >= 40 && targetLetterCount > sourceLetterCount * 2.1) {
        reasons.push('traducerea este mult mai lungă decât originalul (posibilă adăugare de sens)');
    }
    // Sursă „response” + traducere lexical greșită; corecția deterministă ar trebui
    // s-o repare înainte de review, iar acest semnal protejează cazul dacă reapare.
    if (/\bresponse\b/i.test(source) && /(?<![\p{L}])retras(?:ul|ului)?(?![\p{L}])/iu.test(target)) {
        reasons.push('cuvânt incompatibil cu sursa: „response” tradus ca „retrasul”');
    }

    if (/\b(?:but\s+)?you(?:'re|\s+are)\s+not\s+sorry\b/i.test(source) &&
        /(?<![\p{L}])nu\s+ești\s+(?:nici\s+)?părere\s+de\s+rău(?![\p{L}])/iu.test(target)) {
        reasons.push('expresia idiomatică „you are not sorry” este tradusă agramatical');
    }

    if (/\bcould\s+i\s+have\s+a\s+word\b/i.test(source) &&
        /(?<![\p{L}])pot\s+să\s+vorbim(?![\p{L}])/iu.test(target)) {
        reasons.push('nepotrivire de persoană: „Could I…” nu corespunde lui „Pot să vorbim”');
    }

    if (/\bshould\s+at\s+least\s+tell\b/i.test(source) &&
        /(?<![\p{L}])ar\s+trebui\s+măcar\s+(?:le|îi|mi|ne|vă|te|mă)\s+\p{L}+/iu.test(target) &&
        !/(?<![\p{L}])ar\s+trebui\s+măcar\s+să\s+(?:le|îi|mi|ne|vă|te|mă)(?![\p{L}])/iu.test(target)) {
        reasons.push('lipsește „să” într-o construcție cu „ar trebui ... să”');
    }

    if (/\boutnumbered\b/i.test(source) && /\boutnumbered\b/i.test(target)) {
        reasons.push('a rămas un cuvânt englezesc netradus („outnumbered”)');
    }

    // Regresii concrete din QA manual: acestea trebuie să declanșeze revizuire
    // contextuală, nu să treacă automat ca traduceri corecte.
    if (/(?<![\p{L}])strisoarea(?![\p{L}])/iu.test(target)) {
        reasons.push('posibilă deformare ortografică „strisoarea”; verifică sensul și corectează la forma română potrivită');
    }
    if (/(?<![\p{L}])ne-am\s+lipsit(?![\p{L}])/iu.test(target)) {
        reasons.push('formulare suspectă „ne-am lipsit”; verifică sensul din original și context');
    }
    if (/(?<![\p{L}])le\s+mai\s+te\s+ui(?:ți|ti)(?![\p{L}])/iu.test(target)) {
        reasons.push('succesiune de pronume suspectă „le mai te uiți”');
    }
    if (/(?<![\p{L}])(?:așa|asa)\s+and\s+(?:gândeam|gandeam)(?![\p{L}])/iu.test(target)) {
        reasons.push('fragment englezesc netradus în formularea „Așa and gândeam”');
    }
    if (/\bput\s+it\s+in\s+drive\b/i.test(source) &&
        /\b(?:marșarier|marsarier|mers\s+înapoi|mers\s+inapoi|în\s+revers|in\s+revers|înapoi)\b/iu.test(target)) {
        reasons.push('inversare semantică: „put it in drive” a devenit o comandă de mers înapoi');
    }

    // Validare contextuală a continuității: dacă blocul englezesc anterior se termină
    // cu „was/were”, blocul curent începe cu un gerunziu, iar traducerea începe cu
    // o formă clară de persoana I prezent, persoana/timpul s-au schimbat.
    const allItems = Array.isArray(contextItems) ? contextItems : [item];
    const index = getFastItemIndex(allItems, item.id);
    if (index > 0) {
        const previous = allItems[index - 1];
        const previousSource = String(previous.text || '').replace(/<[^>]+>/g, ' ').trim();
        const currentSource = source;
        const previousTarget = String(translatedById[String(previous.id)] || '').replace(/<[^>]+>/g, ' ').trim();
        const beginsEnglishProgressive = /^[a-z]+ing\b/i.test(currentSource);
        const hasPastProgressiveAuxiliary = /\b(?:was|were)\s*$/i.test(previousSource);
        const firstTargetToken = (target.match(/^[“„"'«»(\s-]*([\p{L}-]+)/u) || [])[1] || '';
        const likelyFirstPersonPresent = /(?:ez|esc|iesc)$/iu.test(firstTargetToken);
        const previousTargetContinues = previousTarget && !/[.!?…]["”')\]]*$/u.test(previousTarget);
        const currentSourceNotFirstPerson = !/^(?:I|we)\b/i.test(currentSource);
        if (beginsEnglishProgressive && hasPastProgressiveAuxiliary && previousTargetContinues &&
            currentSourceNotFirstPerson && likelyFirstPersonPresent) {
            reasons.push('nepotrivire de persoană/timp: continuarea „was/were + -ing” a devenit persoana I, prezent');
        }
    }

    return reasons;
}

function collectQualityReviewReasons(item, translation, contextItems, translatedById) {
    return [
        ...detectLocalGrammarReviewReasons(translation),
        ...detectSourceAwareQualityReviewReasons(item, translation, contextItems, translatedById)
    ];
}

function normalizeRepeatedTranslationCheckText(text) {
    return String(text || '')
        .replace(/<[^>]+>/g, ' ')
        .normalize('NFC')
        .toLocaleLowerCase('ro-RO')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function repeatedTranslationSourceSimilarity(firstSource, secondSource) {
    const tokenize = value => new Set(
        (String(value || '').toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || [])
    );
    const first = tokenize(firstSource);
    const second = tokenize(secondSource);
    const union = new Set([...first, ...second]);
    if (!union.size) return 1;
    let intersection = 0;
    for (const token of first) if (second.has(token)) intersection++;
    return intersection / union.size;
}

// Semnal conservator pentru două traduceri consecutive identice când originalele
// au vocabular semnificativ diferit. Nu modifică textele: cere verificare contextuală.
function findRepeatedTranslationIssues(items, translatedById) {
    const issues = [];
    const MAX_SOURCE_TOKEN_SIMILARITY = 0.15;

    for (let i = 0; i < items.length - 1; i++) {
        const first = items[i];
        const second = items[i + 1];
        if (first.musicOnly || second.musicOnly || isJunkOrInterjection(first.text) || isJunkOrInterjection(second.text)) continue;

        const firstId = String(first.id);
        const secondId = String(second.id);
        // Dacă un ID a fost eliminat de filtrul de sursă, cele două elemente
        // pot fi vecine în `items` fără să fie vecine în SRT-ul original.
        const firstNumericId = Number(first.sourceId ?? first.id);
        const secondNumericId = Number(second.sourceId ?? second.id);
        if (Number.isFinite(firstNumericId) && Number.isFinite(secondNumericId) && secondNumericId !== firstNumericId + 1) continue;
        const firstTarget = normalizeRepeatedTranslationCheckText(translatedById[firstId]);
        const secondTarget = normalizeRepeatedTranslationCheckText(translatedById[secondId]);
        if (!firstTarget || firstTarget !== secondTarget) continue;

        const firstSource = normalizeRepeatedTranslationCheckText(first.text);
        const secondSource = normalizeRepeatedTranslationCheckText(second.text);
        if (!firstSource || !secondSource || firstSource === secondSource) continue;

        // Repetiția aceleiași traduceri este un semnal slab pentru replici scurte.
        // Păstrăm verificarea pentru surse mai consistente și numai când vocabularul
        // englezesc diferă aproape complet; detectorul nu modifică textul automat.
        const sourceWordCount = value => (String(value || '').match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || []).length;
        if (sourceWordCount(first.text) < 3 || sourceWordCount(second.text) < 3) continue;

        const similarity = repeatedTranslationSourceSimilarity(first.text, second.text);
        if (similarity >= MAX_SOURCE_TOKEN_SIMILARITY) continue;

        const score = similarity.toFixed(2);
        issues.push({
            item: first,
            pairedItem: second,
            reason: `traducere identică cu ID ${secondId}, deși originalele EN diferă semnificativ (similaritate lexicală ${score}); verifică sensul ambelor replici`
        });
        issues.push({
            item: second,
            pairedItem: first,
            reason: `traducere identică cu ID ${firstId}, deși originalele EN diferă semnificativ (similaritate lexicală ${score}); verifică sensul ambelor replici`
        });
    }

    // Nu emitem avertisment aici: acesta este un semnal preliminar, înainte de
    // verificarea contextuală. Raportarea se face la QA final numai dacă duplicatul
    // persistă după toate corectările; altfel logul ar prezenta drept problemă rămasă
    // o situație pe care verificarea tocmai a reparat-o.
    return issues;
}

// Detectează contaminarea dintre două cue-uri consecutive: traducerea primului
// cue se termină cu o expresie lungă care reapare la începutul traducerii următorului,
// deși originalul primului cue este neterminat. Semnalul nu mută și nu șterge text;
// ambele ID-uri sunt trimise împreună la verificare contextuală.
function findPossibleBoundaryOverlapIssues(items, translatedById) {
    const issues = [];
    const seenPairs = new Set();
    const lowInformationWords = new Set([
        'a', 'ai', 'al', 'ale', 'am', 'ar', 'are', 'as', 'au', 'avea', 'avem', 'aveți',
        'ca', 'că', 'ce', 'cel', 'cea', 'cei', 'cele', 'cu', 'da', 'dar', 'de', 'din',
        'e', 'ea', 'ei', 'el', 'ele', 'era', 'este', 'eu', 'fi', 'fie', 'la', 'le',
        'lui', 'lor', 'mai', 'mă', 'mi', 'ne', 'nici', 'nu', 'o', 'pe', 'pentru',
        'poate', 'pot', 'sa', 'să', 'se', 'și', 'sunt', 'te', 'tu', 'un', 'una', 'în'
    ]);
    const clean = value => String(value || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\|/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const words = value => clean(value)
        .normalize('NFC')
        .toLocaleLowerCase('ro-RO')
        .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || [];
    const sourceIsUnfinished = value => {
        const text = clean(value);
        if (!text) return false;
        // Punctuația finală indică de regulă o propoziție completă; elipsele sau
        // lipsa punctuației finale indică adesea că sursa continuă în cue-ul următor.
        const endsWithEllipsis = /(?:\.{3}|…)\s*$/u.test(text);
        const endsWithSentencePunctuation = /[.!?]["”’')\]]*\s*$/u.test(text);
        return endsWithEllipsis || !endsWithSentencePunctuation;
    };

    // Dacă originalul englezesc repetă explicit aceeași secvență la limita
    // dintre cue-uri, suprapunerea românească este susținută de sursă. Acceptăm
    // și reluări ezitante înaintea secvenței complete, de tipul „Let's... let's...
    // let's take a look at today”, nu doar potriviri de la primul cuvânt.
    const hasSourceBoundaryRepeat = (firstSource, secondSource) => {
        const sourceWords = value => clean(value)
            .normalize('NFC')
            .toLocaleLowerCase('en-US')
            .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || [];
        const firstWords = sourceWords(firstSource);
        const secondWords = sourceWords(secondSource);
        if (firstWords.length < 3 || secondWords.length < 3) return false;

        const sourceLowInformationWords = new Set([
            'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'but', 'by',
            'do', 'does', 'did', 'for', 'from', 'he', 'her', 'hers', 'him', 'his',
            'i', 'if', 'in', 'is', 'it', "it's", 'its', 'me', 'my', 'of', 'on',
            'or', 'our', 'she', 'that', 'the', 'their', 'them', 'there', 'these',
            'they', 'this', 'those', 'to', 'us', 'was', 'we', 'were', 'what',
            'when', 'where', 'which', 'who', 'will', 'with', 'you', 'your'
        ]);
        const maxLength = Math.min(8, firstWords.length, secondWords.length);
        // Căutăm sufixul primului cue în primele cuvinte ale celui de-al doilea.
        // Astfel, reluări precum „Let's... let's... let's take...” sunt recunoscute,
        // fără a trata o expresie îndepărtată din replică drept dovadă de continuitate.
        for (let length = maxLength; length >= 3; length--) {
            const suffix = firstWords.slice(-length);
            // Cel puțin un termen cu conținut trebuie să facă parte din suprapunere;
            // evităm să suprimăm semnale pe baza unor formule doar gramaticale.
            const informative = suffix.some(word => word.length >= 4 && !sourceLowInformationWords.has(word));
            if (!informative) continue;

            const maxStart = Math.min(8, secondWords.length - length);
            for (let start = 0; start <= maxStart; start++) {
                if (suffix.every((word, index) => word === secondWords[start + index])) return true;
            }
        }
        return false;
    };

    // Evită alarmele false când aceeași expresie românească este justificată de
    // același sens prezent în AMBELE originale consecutive (ex. „vreau să le știu”
    // pentru „want to know” din ambele cue-uri). Cerem minimum două dovezi lexicale
    // concordante în ambele originale; detectorul nu face o traducere automată.
    const sourceGroundingPairs = [
        { targetWords: ['vreau', 'vrei', 'vrea', 'vrem', 'vreți', 'vreti', 'vor', 'dorești', 'doresti', 'doresc', 'dorește', 'doreste', 'dorea', 'dorit'], source: /\b(?:want|wants|wanted|wish|wishes|wished|desire|desires|desired)\b/iu },
        { targetWords: ['știu', 'stiu', 'știe', 'stie', 'știi', 'stii', 'știm', 'stim', 'știți', 'stiti', 'știam', 'stiam', 'știa', 'stia', 'știut', 'stiut', 'cunoaște', 'cunoaste', 'cunosc', 'cunoști', 'cunosti'], source: /\b(?:know|knows|knew|known|knowing)\b/iu },
        { targetWords: ['lucru', 'lucruri', 'lucrurile'], source: /\bthings?\b/iu },
        { targetWords: ['târziu', 'tarziu'], source: /\b(?:late|later)\b/iu },
        { targetWords: ['prea'], source: /\btoo\b/iu },
        { targetWords: ['nu'], source: /\b(?:no|not|never|don['’]?t|doesn['’]?t|didn['’]?t|isn['’]?t|aren['’]?t|wasn['’]?t|weren['’]?t|can['’]?t|cannot|won['’]?t|wouldn['’]?t)\b/iu },
        { targetWords: ['ochi', 'ochii'], source: /\beyes?\b/iu },
        { targetWords: ['drum', 'drumul'], source: /\broad\b/iu },
        { targetWords: ['găsi', 'gasi', 'găsească', 'gaseasca', 'găsești', 'gasesti', 'găsim', 'gasim', 'găsit', 'gasit'], source: /\b(?:find|finds|found|finding)\b/iu },
        { targetWords: ['lume', 'lumii'], source: /\bworld\b/iu },
        { targetWords: ['telefon', 'telefonul'], source: /\bphone\b/iu },
        { targetWords: ['strigi', 'strig', 'strige', 'țipi', 'tipi', 'țip', 'tip'], source: /\b(?:yell|yells|yelled|shout|shouts|shouted|scream|screams|screamed)\b/iu }
    ];
    const targetPhraseGroundedInBothSources = (phrase, firstSource, secondSource) => {
        // `words()` deja tokeniza textul; setul evită limitele `\b` din JavaScript,
        // care nu recunosc uniform toate literele românești cu diacritice.
        const targetWords = new Set(words(phrase));
        const first = clean(firstSource).normalize('NFC');
        const second = clean(secondSource).normalize('NFC');
        let groundedMeanings = 0;
        for (const pair of sourceGroundingPairs) {
            if (pair.targetWords.some(word => targetWords.has(word)) && pair.source.test(first) && pair.source.test(second)) {
                groundedMeanings++;
            }
        }
        return groundedMeanings >= 2;
    };

    for (let i = 0; i < items.length - 1; i++) {
        const first = items[i];
        const second = items[i + 1];
        if (first.musicOnly || second.musicOnly || isJunkOrInterjection(first.text) || isJunkOrInterjection(second.text)) continue;

        const firstId = String(first.id);
        const secondId = String(second.id);
        const firstNumericId = Number(first.sourceId ?? first.id);
        const secondNumericId = Number(second.sourceId ?? second.id);
        if (!Number.isFinite(firstNumericId) || !Number.isFinite(secondNumericId) ||
            secondNumericId !== firstNumericId + 1) continue;

        const firstSource = clean(first.text);
        if (!sourceIsUnfinished(firstSource)) continue;

        const firstTargetWords = words(translatedById[firstId]);
        const secondTargetWords = words(translatedById[secondId]);
        // Exigență conservatoare: cel puțin patru cuvinte consecutive la coada primului
        // cue, regăsite aproape de începutul următorului cue, cu minimum două cuvinte
        // semnificative. Nu alarmează pe conectori sau expresii foarte scurte.
        if (firstTargetWords.length < 4 || secondTargetWords.length < 4) continue;

        let match = null;
        const maxLength = Math.min(8, firstTargetWords.length, secondTargetWords.length);
        for (let length = maxLength; length >= 4 && !match; length--) {
            const phrase = firstTargetWords.slice(-length);
            const meaningful = phrase.filter(word => word.length >= 4 && !lowInformationWords.has(word));
            if (meaningful.length < 2) continue;

            const lastStart = Math.min(8, secondTargetWords.length - length);
            for (let start = 0; start <= lastStart; start++) {
                if (phrase.every((word, index) => word === secondTargetWords[start + index])) {
                    match = { phrase: phrase.join(' '), length };
                    break;
                }
            }
        }
        if (!match) continue;

        // Repetiția este legitimă dacă originalele susțin sensul expresiei.
        // Două originale cu aceeași secvență la limita dintre cue-uri oferă o
        // dovadă directă suplimentară și evită alarme de tipul „too soon to”.
        if (hasSourceBoundaryRepeat(firstSource, clean(second.text)) ||
            targetPhraseGroundedInBothSources(match.phrase, firstSource, clean(second.text))) continue;

        const pairKey = `${firstId}:${secondId}:${match.phrase}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        const reason = `posibilă suprapunere lexicală la limită: ultimii ${match.length} termeni („${match.phrase}”) din traducerea ID ${firstId} apar și aproape de începutul traducerii ID ${secondId}, iar originalul ID ${firstId} este neterminat; compară ambele originale și elimină din primul cue textul provenit din al doilea numai dacă sursa nu îl justifică; nu muta text între ID-uri`;
        issues.push({ item: first, pairedItem: second, reason });
        issues.push({
            item: second,
            pairedItem: first,
            reason: `posibilă suprapunere lexicală cu ID ${firstId}: expresia „${match.phrase}” apare la coada traducerii precedente și la începutul acestei traduceri; păstrează repetiția numai dacă ambele originale o justifică`
        });
    }

    return issues;
}

// Detectează suprapunerea posibilă a sensului între două subtitrări consecutive.
// Este strict un semnal pentru QA: nu rescrie automat traducerile.
function findAdjacentSemanticOverlapIssues(items, translatedById) {
    const issues = [];
    const seenPairs = new Set();
    const lowInformationWords = new Set([
        'a', 'ai', 'al', 'ale', 'am', 'ar', 'are', 'as', 'au', 'avea', 'avem', 'aveți', 'aveau',
        'ca', 'că', 'ce', 'cel', 'cea', 'cei', 'cele', 'ceva', 'cu', 'da', 'dar', 'de', 'din',
        'doar', 'dupa', 'după', 'e', 'ea', 'ei', 'el', 'ele', 'era', 'eram', 'erau', 'este',
        'eu', 'fie', 'fi', 'fii', 'fim', 'fiți', 'la', 'le', 'li', 'lui', 'lor', 'mai', 'mă',
        'mi', 'mie', 'ne', 'ni', 'nici', 'nu', 'o', 'or', 'ori', 'pe', 'pentru', 'poate',
        'pot', 'sa', 'să', 'se', 'și', 'sînt', 'sunt', 'te', 'tu', 'un', 'una', 'unei', 'unui',
        'vă', 'vi', 'voi', 'vor', 'vrea', 'vreau', 'vrei', 'în', 'între', 'îți', 'îl', 'îmi',
        'își', 'acest', 'aceasta', 'acesta', 'asta', 'ăsta', 'aici', 'acolo', 'bine', 'foarte',
        'tot', 'toate', 'toți', 'toate', 'lucru', 'lucruri'
    ]);

    const clean = value => String(value || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\|/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const words = value => clean(value)
        .normalize('NFC')
        .toLocaleLowerCase('ro-RO')
        .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || [];
    const hasTerminalPunctuation = value => /[.!?…]["”’')\]]*\s*$/u.test(clean(value));
    const sourceBeginsLowercase = value => /^[\s"“”'‘’([{—–-]*\p{Ll}/u.test(clean(value));
    const sourceLooksLikeContinuation = (firstSource, secondSource) =>
        Boolean(clean(firstSource) && clean(secondSource)) &&
        !hasTerminalPunctuation(firstSource) &&
        sourceBeginsLowercase(secondSource);

    // Expresiile comune se caută doar în ultimele șapte cuvinte ale primei
    // traduceri; astfel țintim sensul anticipat spre limita dintre două cue-uri,
    // nu repetițiile îndepărtate din două propoziții mai lungi.
    const findSharedPhraseNearBoundary = (firstTarget, secondTarget) => {
        const firstWords = words(firstTarget);
        const secondWords = words(secondTarget);
        if (firstWords.length < 2 || secondWords.length < 2) return null;

        const firstStart = Math.max(0, firstWords.length - 7);
        const candidates = [];
        for (let length = Math.min(4, firstWords.length, secondWords.length); length >= 2; length--) {
            for (let i = firstStart; i <= firstWords.length - length; i++) {
                // O expresie comună aflată la începutul unui cue scurt nu este o
                // suprapunere „la limită”. Permitem cel mult un cuvânt nepartajat
                // după expresia comună în prima traducere.
                if (firstWords.length - (i + length) > 1) continue;

                const phraseWords = firstWords.slice(i, i + length);
                const meaningfulWords = phraseWords.filter(word =>
                    word.length >= 4 && !lowInformationWords.has(word)
                );
                if (!meaningfulWords.length) continue;

                for (let j = 0; j <= secondWords.length - length; j++) {
                    const secondPhrase = secondWords.slice(j, j + length);
                    if (phraseWords.every((word, index) => word === secondPhrase[index])) {
                        candidates.push({
                            phrase: phraseWords.join(' '),
                            length,
                            firstStart: i,
                            secondStart: j,
                            secondDistanceToEdge: Math.min(j, secondWords.length - (j + length))
                        });
                    }
                }
            }
            if (candidates.length) break;
        }
        if (!candidates.length) return null;
        candidates.sort((a, b) =>
            b.length - a.length ||
            a.secondDistanceToEdge - b.secondDistanceToEdge ||
            b.firstStart - a.firstStart
        );
        return candidates[0];
    };

    // Nu semnalăm o expresie comună dacă termenul semantic principal al acesteia
    // este justificat de același verb/concept în ambele originale englezești.
    // Lista este intenționat conservatoare: preferăm să păstrăm avertismentul când
    // nu avem o legătură lexicală clară între original și expresia românească.
    const repeatedSourceConceptSupportsOverlap = (phrase, firstSource, secondSource) => {
        const normalizeWord = value => String(value || '')
            .normalize('NFD')
            .replace(/\p{M}/gu, '')
            .toLocaleLowerCase('ro-RO');
        const targetWords = new Set(words(phrase).map(normalizeWord));
        const firstEnglish = clean(firstSource).toLocaleLowerCase('en-US');
        const secondEnglish = clean(secondSource).toLocaleLowerCase('en-US');
        const groundingPairs = [
            { target: ['adus', 'adusa', 'aduse', 'adusi', 'aduc', 'aduce', 'aduceti', 'aduceau'], source: /\b(?:bring|brings|bringing|brought)\b/iu },
            { target: ['vreau', 'vrei', 'vrea', 'vrem', 'vreti', 'vor', 'doresc', 'doresti', 'doreste', 'dorit'], source: /\b(?:want|wants|wanted|wish|wishes|wished|desire|desires|desired)\b/iu },
            { target: ['stiu', 'stie', 'stii', 'stim', 'stiti', 'stiut', 'cunosc', 'cunoaste', 'cunosti'], source: /\b(?:know|knows|knew|known|knowing)\b/iu },
            { target: ['spun', 'spune', 'spui', 'spus', 'zic', 'zis'], source: /\b(?:say|says|said|tell|tells|told|speak|speaks|spoke|spoken)\b/iu },
            { target: ['dat', 'dau', 'dai', 'da', 'ofer', 'ofera', 'oferit'], source: /\b(?:give|gives|gave|given|offer|offers|offered)\b/iu },
            { target: ['fac', 'faci', 'face', 'facem', 'faceti', 'facut'], source: /\b(?:do|does|did|done|make|makes|made|making)\b/iu },
            { target: ['vad', 'vezi', 'vede', 'vedem', 'vedeti', 'vazut'], source: /\b(?:see|sees|saw|seen|seeing)\b/iu },
            { target: ['iubesc', 'iubesti', 'iubeste', 'iubim', 'iubit'], source: /\b(?:love|loves|loved|loving)\b/iu },
            { target: ['ajut', 'ajuti', 'ajuta', 'ajutat'], source: /\b(?:help|helps|helped|helping)\b/iu },
            { target: ['vin', 'vine', 'venim', 'veniti', 'venit'], source: /\b(?:come|comes|coming|came)\b/iu },
            { target: ['merg', 'merge', 'mergem', 'mergeti', 'mers'], source: /\b(?:go|goes|going|went|gone)\b/iu }
        ];
        return groundingPairs.some(pair =>
            pair.target.some(word => targetWords.has(word)) &&
            pair.source.test(firstEnglish) &&
            pair.source.test(secondEnglish)
        );
    };

    for (let i = 0; i < items.length - 1; i++) {
        const first = items[i];
        const second = items[i + 1];
        if (first.musicOnly || second.musicOnly || isJunkOrInterjection(first.text) || isJunkOrInterjection(second.text)) continue;

        const firstId = String(first.id);
        const secondId = String(second.id);
        const firstNumericId = Number(first.sourceId ?? first.id);
        const secondNumericId = Number(second.sourceId ?? second.id);
        // Nu traversăm ID-uri eliminate de filtrul de interjecții sau lipsă din SRT.
        if (!Number.isFinite(firstNumericId) || !Number.isFinite(secondNumericId) || secondNumericId !== firstNumericId + 1) continue;

        const firstSource = clean(first.text);
        const secondSource = clean(second.text);
        if (!sourceLooksLikeContinuation(firstSource, secondSource)) continue;

        const firstTarget = clean(translatedById[firstId]);
        const secondTarget = clean(translatedById[secondId]);
        if (!firstTarget || !secondTarget || !hasTerminalPunctuation(firstTarget)) continue;

        const overlap = findSharedPhraseNearBoundary(firstTarget, secondTarget);
        if (!overlap) continue;

        // Dacă aceeași acțiune este prezentă explicit în ambele originale, repetarea
        // din română poate fi legitimă (ex. „I brought you flowers” / „I also brought
        // you beer” -> „V-am adus...” / „...v-am adus...”). Nu o raportăm ca duplicare.
        if (repeatedSourceConceptSupportsOverlap(overlap.phrase, firstSource, secondSource)) continue;

        const pairKey = `${firstId}:${secondId}:${overlap.phrase}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        const reason = `posibilă suprapunere de sens între ID ${firstId} și ${secondId}: expresia „${overlap.phrase}” apare în ambele traduceri; originalul EN al ID ${firstId} continuă fără punctuație, dar traducerea lui încheie o propoziție. Verifică dacă ID ${firstId} anticipează sensul din ID ${secondId}; corectează numai redundanța demonstrabilă, fără a muta text între ID-uri`;
        issues.push({ item: first, pairedItem: second, reason });
        issues.push({
            item: second,
            pairedItem: first,
            reason: `posibilă suprapunere de sens cu ID ${firstId}: expresia „${overlap.phrase}” apare în ambele traduceri; compară sursa și contextul înainte să păstrezi sau să corectezi textul`
        });
    }

    // Ca și la traducerile duplicate, avertismentul se amână până la QA final.
    // O suprapunere detectată înainte de Quality Retry nu este o problemă rămasă
    // dacă verificarea contextuală a eliminat-o.
    return issues;
}

function findRepeatedBoundaryConnectorIssues(items, translatedById) {
    const issues = [];
    const seen = new Set();
    const connectorPattern = /(?:^|\s)(dar|însă|totuși)\s*[,;:!?…]*$/iu;
    const leadingConnectorPattern = /^\s*(?:[-–—]\s*)?(dar|însă|totuși)(?![\p{L}])/iu;
    const sourceTailPattern = /(?:^|\s)(but|however|yet|still|nevertheless)\s*[,;:!?…]*$/iu;
    const sourceHeadPattern = /^\s*(?:[-–—]\s*)?(but|however|yet|still|nevertheless)\b/iu;

    const sourceConnectorSupportsRomanian = (englishConnector, romanianConnector) => {
        const en = String(englishConnector || '').toLocaleLowerCase('en-US');
        const ro = String(romanianConnector || '').toLocaleLowerCase('ro-RO');
        const supported = {
            but: ['dar', 'însă'],
            however: ['dar', 'însă', 'totuși'],
            yet: ['dar', 'însă', 'totuși'],
            still: ['dar', 'însă', 'totuși'],
            nevertheless: ['dar', 'însă', 'totuși']
        };
        return Boolean(supported[en]?.includes(ro));
    };

    for (let i = 0; i < items.length - 1; i++) {
        const currentItem = items[i];
        const nextItem = items[i + 1];
        if (currentItem.musicOnly || nextItem.musicOnly || isJunkOrInterjection(currentItem.text) || isJunkOrInterjection(nextItem.text)) continue;

        const currentText = String(translatedById[String(currentItem.id)] || '')
            .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const nextText = String(translatedById[String(nextItem.id)] || '')
            .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const tail = currentText.match(connectorPattern);
        const head = nextText.match(leadingConnectorPattern);
        if (!tail || !head || tail[1].toLocaleLowerCase('ro-RO') !== head[1].toLocaleLowerCase('ro-RO')) continue;

        // Folosim ambele originale pentru a afla ce fragment justifică de fapt
        // conectorul. Astfel, nu raportăm o dublare mecanic doar din română.
        const sourceCurrent = String(currentItem.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const sourceNext = String(nextItem.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const sourceTail = sourceCurrent.match(sourceTailPattern);
        const sourceHead = sourceNext.match(sourceHeadPattern);
        const tailSupportedBySource = sourceTail && sourceConnectorSupportsRomanian(sourceTail[1], tail[1]);
        const headSupportedBySource = sourceHead && sourceConnectorSupportsRomanian(sourceHead[1], head[1]);

        // Dacă ambele surse au același conector în aceeași poziție, păstrăm
        // traducerea lor: nu presupunem că repetiția vine dintr-o eroare AI.
        if (tailSupportedBySource && headSupportedBySource) continue;

        // Când conectorul de la final este susținut de originalul precedent,
        // semnalăm blocul următor (al cărui original nu începe cu acel conector).
        // În celelalte cazuri, semnalăm conectorul introdus la finalul blocului
        // curent; de ex. ID 669 adăuga „dar”, deși originalul continuă abia la 670
        // cu „but”.
        const issueItem = tailSupportedBySource && !headSupportedBySource ? nextItem : currentItem;
        const issueId = String(issueItem.id);
        if (seen.has(issueId)) continue;
        seen.add(issueId);

        const reason = `conector repetat între două fragmente consecutive: „${tail[1]}”; originalele EN indică plasarea conectorului ${tailSupportedBySource ? `la ID ${currentItem.id}` : headSupportedBySource ? `la ID ${nextItem.id}` : 'doar după compararea contextului'}; verifică dacă traducerea a adăugat conectorul în blocul greșit`;
        issues.push({ item: issueItem, reason, pairedItem: issueItem === currentItem ? nextItem : currentItem });
    }
    return issues;
}

function applyDeterministicBoundaryConnectorFixes(items, translatedById) {
    let fixed = 0;
    const sourceSupports = (englishConnector, romanianConnector) => {
        const en = String(englishConnector || '').toLocaleLowerCase('en-US');
        const ro = String(romanianConnector || '').toLocaleLowerCase('ro-RO');
        const supported = {
            but: ['dar', 'însă'],
            however: ['dar', 'însă', 'totuși'],
            yet: ['dar', 'însă', 'totuși'],
            still: ['dar', 'însă', 'totuși'],
            nevertheless: ['dar', 'însă', 'totuși']
        };
        return Boolean(supported[en]?.includes(ro));
    };
    const roTail = /(?:^|\s)(dar|însă|totuși)\s*[,;:!?…]*$/iu;
    const roHead = /^\s*(?:[-–—]\s*)?(dar|însă|totuși)(?![\p{L}])/iu;
    const enTail = /(?:^|\s)(but|however|yet|still|nevertheless)\s*[,;:!?…]*$/iu;
    const enHead = /^\s*(?:[-–—]\s*)?(but|however|yet|still|nevertheless)\b/iu;

    for (let i = 0; i < items.length - 1; i++) {
        const current = items[i];
        const next = items[i + 1];
        if (current.musicOnly || next.musicOnly || isJunkOrInterjection(current.text) || isJunkOrInterjection(next.text)) continue;
        const currentId = String(current.id);
        const nextId = String(next.id);
        const currentRo = String(translatedById[currentId] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const nextRo = String(translatedById[nextId] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const roCurrentTail = currentRo.match(roTail);
        const roNextHead = nextRo.match(roHead);
        if (!roCurrentTail || !roNextHead || roCurrentTail[1].toLocaleLowerCase('ro-RO') !== roNextHead[1].toLocaleLowerCase('ro-RO')) continue;

        const currentEn = String(current.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const nextEn = String(next.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const enCurrentTail = currentEn.match(enTail);
        const enNextHead = nextEn.match(enHead);
        const currentSupported = enCurrentTail && sourceSupports(enCurrentTail[1], roCurrentTail[1]);
        const nextSupported = enNextHead && sourceSupports(enNextHead[1], roNextHead[1]);

        // Corectăm numai când originalul următor justifică conectorul, iar
        // originalul curent nu îl justifică la sfârșit. Exemplul sigur este
        // „... EF1”, dar” + „dar n-a fost ea” / EN: „EF1,” + „but it wasn't her”.
        if (!currentSupported && nextSupported) {
            const before = String(translatedById[currentId] || '');
            const after = before.replace(/\s+(?:dar|însă|totuși)\s*[,;:!?…]*\s*$/iu, '').trimEnd();
            if (after && after !== before.trimEnd()) {
                translatedById[currentId] = formatSubtitleLine(after);
                fixed++;
                console.log(`${c.green}✔ [Boundary Connector Fix] ID ${currentId}: conectorul de la final eliminat; originalul ID ${nextId} începe cu „${enNextHead[1]}”.${c.reset}`);
            }
        }
    }
    return fixed;
}

async function runLocalGrammarQualityPass(items, translatedById) {
    let autoFixed = 0;
    const flagged = [];

    for (const item of items) {
        if (item.musicOnly) continue;
        const id = String(item.id);
        const current = String(translatedById[id] || '');
        if (!current.trim()) continue;
        if (isJunkOrInterjection(item.text)) continue;

        // Aplicăm întâi numai corecțiile ancorate clar în sursă și typo-fix-urile
        // cu risc mic; astfel AI primește o versiune curățată, nu duplică munca locală.
        const sourceFixed = applySourceGroundedSemanticFixes(item.text, current);
        const fixed = applyLocalGrammarDeterministicFixes(sourceFixed);
        if (fixed !== current) {
            translatedById[id] = formatSubtitleLine(fixed);
            autoFixed++;
        }

        const effective = String(translatedById[id] || '');
        const reasons = collectQualityReviewReasons(item, effective, items, translatedById);
        const missingExplicitTerms = getMissingExplicitAnatomicalTerms(item.text, effective);
        if (missingExplicitTerms.length) {
            reasons.push(`detaliu anatomic explicit pierdut din original: ${missingExplicitTerms.join(', ')}`);
        }
        if (reasons.length) {
            flagged.push({ item, reasons: [...new Set(reasons)] });
        }
    }

    // Verifică relația dintre două blocuri: un „dar” la sfârșitul primului
    // bloc urmat imediat de „dar” la începutul celui de-al doilea poate dubla
    // aceeași legătură logică. Ambele fragmente sunt trimise împreună la review.
    for (const boundaryIssue of findRepeatedBoundaryConnectorIssues(items, translatedById)) {
        const id = String(boundaryIssue.item.id);
        const existing = flagged.find(entry => String(entry.item.id) === id);
        if (existing) {
            if (!existing.reasons.includes(boundaryIssue.reason)) existing.reasons.push(boundaryIssue.reason);
        } else {
            flagged.push({ item: boundaryIssue.item, reasons: [boundaryIssue.reason] });
        }
    }

    // Două traduceri consecutive identice pe surse lexical diferite sunt trimise
    // împreună la același review punctual; nu facem înlocuiri automate de ID-uri.
    for (const duplicateIssue of findRepeatedTranslationIssues(items, translatedById)) {
        const id = String(duplicateIssue.item.id);
        const existing = flagged.find(entry => String(entry.item.id) === id);
        if (existing) {
            if (!existing.reasons.includes(duplicateIssue.reason)) existing.reasons.push(duplicateIssue.reason);
        } else {
            flagged.push({ item: duplicateIssue.item, reasons: [duplicateIssue.reason] });
        }
    }

    // Semnal separat pentru sens anticipat în traducerea precedentă (ex. EN cue 130
    // continuă în 131, dar RO 130 încheie fraza și repetă „în comun” din RO 131).
    for (const overlapIssue of findAdjacentSemanticOverlapIssues(items, translatedById)) {
        const id = String(overlapIssue.item.id);
        const existing = flagged.find(entry => String(entry.item.id) === id);
        if (existing) {
            if (!existing.reasons.includes(overlapIssue.reason)) existing.reasons.push(overlapIssue.reason);
        } else {
            flagged.push({ item: overlapIssue.item, reasons: [overlapIssue.reason] });
        }
    }

    // O suprapunere lexicală la limită nu dovedește singură contaminarea;
    // această verificare rămâne doar diagnostică și nu declanșează rescriere automată.

    flagged.sort((a, b) => getFastItemIndex(items, a.item.id) - getFastItemIndex(items, b.item.id));

    console.log(`${c.green}[GRAMATICĂ] Verificare locală încheiată; ${autoFixed} corecții directe aplicate.${c.reset}`);

    return {
        autoFixed,
        flaggedItems: flagged.map(entry => entry.item),
        reasonsById: Object.fromEntries(flagged.map(entry => [String(entry.item.id), entry.reasons.join('; ')]))
    };
}

// ============================================================
// SEMANTIC SPOT CHECK — SEMNALE PUTERNICE DE TRADUCERE CORUPTĂ
// Nu încearcă să evalueze stilul. Marchează doar construcții care sunt
// suficient de suspecte încât merită o singură verificare AI punctuală.
// Se combină cu Micro-Grammar în același request pentru a nu adăuga
// o trecere Gemini separată.
// ============================================================

function detectSemanticSpotCheckReasons(text) {
    const clean = String(text || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!clean) return [];

    const reasons = [];

    // Construcție clar suspectă: româna standard cere „în fața cui/câtor...”,
    // nu „în fața a cine/câți...”. Verificăm doar formele cu risc foarte mare.
    if (/(?<![\p{L}])în\s+fața\s+a\s+(?:cine|câți|câte)(?=$|[^\p{L}])/iu.test(clean)) {
        reasons.push('construcție foarte suspectă „în fața a cine/câți...”');
    }

    // „De câți oameni a fost nevoie” este construcția firească. Dacă lipsește
    // prepoziția „de”, trimitem replica la verificare punctuală.
    if (/\b(?:câți|câte)\s+(?:\p{L}+\s+){0,5}a\s+fost\s+nevoie\b/iu.test(clean) &&
        !/\bde\s+(?:câți|câte)\s+(?:\p{L}+\s+){0,5}a\s+fost\s+nevoie\b/iu.test(clean)) {
        reasons.push('posibilă lipsă a prepoziției „de” în construcția „a fost nevoie”');
    }

    // Concatenări fără spațiu observate în QA. Sunt foarte specifice și
    // nu modifică automat textul; doar declanșează verificarea punctuală.
    if (/\b(?:unimpact|unregizor|unregizoare|unactor|oameniiși)\b/iu.test(clean)) {
        reasons.push('posibilă concatenare accidentală de cuvinte');
    }

    // „am învățat-o Biblia” / „ai învățat-o cartea” sunt semnale foarte puternice
    // de structură coruptă; nu marcăm construcții cu „pe” (care pot fi valide).
    if (/\b(?:am|ai|a|au|ați|aveam|aveai|avea)\s+învățat-o\s+(?!pe\b)\p{L}{2,}\b/iu.test(clean)) {
        reasons.push('structură suspectă după „învățat-o”');
    }

    // Cazul observat în QA: „ce și tu și eu avem nevoie să...”
    // Este suficient de specific pentru a evita false positive-uri.
    if (/\b(?:ce|ceea\s+ce)\s+și\s+tu\s+și\s+eu\s+avem\s+nevoie\s+să\b/iu.test(clean)) {
        reasons.push('construcție semantică suspectă „și tu și eu avem nevoie...”');
    }

    return reasons;
}

function runSemanticSpotCheck(items, translatedById) {
    const flagged = [];

    for (const item of items) {
        if (item.musicOnly) continue;
        const current = String(translatedById[String(item.id)] || '');
        if (!current.trim()) continue;
        if (isJunkOrInterjection(item.text)) continue;

        const reasons = detectSemanticSpotCheckReasons(current);
        if (reasons.length) flagged.push({ item, reasons });
    }

    console.log(`${c.green}[Semantic Spot Check] Verificare punctuală încheiată.${c.reset}`);
    return flagged.map(entry => entry.item);
}

// ============================================================
// RECUPERARE FINALĂ — TRADUCERI DEVENITE GOALE
// ============================================================

// Recuperarea finală folosește loturi mici pentru ca un singur răspuns JSON
// malformat să nu compromită toate replicile goale. Split-ul este limitat la
// două niveluri; nu transformăm o problemă de format într-un val nelimitat de apeluri.
const FINAL_EMPTY_RECOVERY_BATCH_SIZE = 10;
const FINAL_EMPTY_RECOVERY_MAX_JSON_SPLIT_DEPTH = 2;
const FINAL_EMPTY_RECOVERY_JSON_RETRY_DELAY_MS = 1200;

function isRecoverableJsonParseError(error) {
    const message = String(error?.message || error || '');
    return /JSON Parse failed|Unexpected token|Unexpected end of JSON|Expected ',' or '}'|Expected property name|Bad control character|unterminated string|conținut gol|empty content/i.test(message);
}

// Întoarce un motiv explicit când o traducere de recuperare nu este acceptată.
function assessEmptyRecoveryCandidate(item, candidateRaw) {
    if (candidateRaw === undefined || candidateRaw === null) {
        return { ok: false, reason: 'ID absent din răspunsul Gemini' };
    }
    if (isEmptyRecoverySoundCueSkip(candidateRaw) && !isStandaloneNonDialogueSoundCue(item.text)) {
        return { ok: false, reason: 'markerul de omitere este permis doar pentru un cue non-dialogat din sursă' };
    }

    const candidate = formatSubtitleLine(String(candidateRaw || ''));
    if (!candidate || !candidate.replace(/<[^>]+>/g, '').trim()) {
        return { ok: false, reason: 'Gemini a returnat text gol' };
    }
    if (hasUntranslatedEnglish(item.text, candidate)) {
        return { ok: false, reason: 'textul conține engleză netradusă' };
    }
    if (hasCorruptedSubtitleText(candidate, item.text)) {
        return { ok: false, reason: 'textul a fost respins de verificarea de corupere' };
    }
    if (hasLostExplicitSourceTerm(item.text, candidate)) {
        return { ok: false, reason: 'traducerea pierde un termen explicit din original' };
    }
    return { ok: true, candidate };
}

const EMPTY_RECOVERY_SOUND_CUE_SKIP = '__RO_ST_SKIP_SOUND_CUE__';

function isEmptyRecoverySoundCueSkip(value) {
    return String(value ?? '').trim() === EMPTY_RECOVERY_SOUND_CUE_SKIP;
}

function getIntentionallySuppressedTranslationIds(keyStates) {
    if (!(keyStates._intentionallySuppressedTranslationIds instanceof Set)) {
        keyStates._intentionallySuppressedTranslationIds = new Set();
    }
    return keyStates._intentionallySuppressedTranslationIds;
}

function markIntentionalSoundCueSuppressed(item, translatedById, keyStates) {
    const id = String(item.id);
    getIntentionallySuppressedTranslationIds(keyStates).add(id);
    translatedById[id] = '';
}

function buildEmptyRecoveryPrompt(batch, strictJsonRetry = false, stageLabel = 'Empty Recovery', forceTranslate = false) {
    return `
${stageLabel.toUpperCase()} — TRADUCERI RĂMASE GOALE.

Tradu în română naturală fiecare replică din lista de mai jos. Aceste blocuri au trecut deja de filtrarea inițială a subtitrărilor. Pentru dialogul obișnuit, fragmente incomplete, replici de un singur cuvânt, întrebări și reacții cu sens, întoarce întotdeauna o traducere română nevidă. Nu lăsa câmpul text gol și nu omite niciun ID. Pentru dialog normal, returnează numai textul tradus, fără paranteze rotunde/drepte adăugate în jurul replicii.

Toate elementele de mai jos au trecut deja de filtrul local pentru cue-uri sonore. Tratează fiecare intrare ca pe un fragment scurt de replică/rostire și redă-i sensul în română ca text de dialog, nu ca etichetă de acțiune sau indicație scenică/sonoră. Nu transforma textul în formulări precum „oftează”, „râsete”, „muzică în fundal” sau „suspină” și nu adăuga paranteze pentru a-l prezenta ca indicație. Pentru o sursă foarte scurtă, alege cea mai firească formulare orală pe care o susține textul, fără să inventezi informații. Fiecare ID trebuie să primească o traducere românească nevidă. Nu inventa omisiuni intenționate.
Nu folosi niciun marker intern, token special sau placeholder în câmpul text. Clasificarea și omiterea cue-urilor sonore sunt responsabilitatea verificării locale, nu a modelului.
${forceTranslate ? '\nRECUPERARE OBLIGATORIE: răspunsul anterior a folosit un marker de omitere nepermis pentru aceste ID-uri. Tradu fiecare ID de mai jos ca fragment scurt de dialog; markerul special este interzis. Nu îl reformula ca etichetă de sunet sau indicație scenică și nu omite nimic.' : ''}
Returnează DOAR un array JSON valid, cu exact un obiect per ID, în aceeași ordine. Fiecare obiect trebuie să aibă câmpurile id (număr întreg) și text (șir). Nu include markdown, explicații sau alte câmpuri.
${strictJsonRetry ? '\nRETRY TEHNIC: întoarce numai JSON valid, păstrează exact ID-urile și nu lăsa niciun câmp text gol.' : ''}

REPLICILE DE TRADUS:
${JSON.stringify(batch.map(item => ({ id: item.id, text: item.text })), null, 2)}
`;
}

// Recuperare inițială în loturi mici. Un JSON malformat afectează cel mult lotul curent;
// după un retry JSON, acesta se împarte treptat. Erorile API (mai ales 503) opresc etapa
// fără cereri suplimentare în rafală; traducerile deja recuperate rămân păstrate.
async function recoverEmptyTranslationsBatched(items, translatedById, keyStates, stageLabel = 'Empty Recovery') {
    // Doar clasificatorul local poate decide omiterea intenționată a unui cue sonor.
    // Nu cerem Gemini să decidă asta: marker-ele returnate pentru dialog produceau
    // split-uri repetate, cereri individuale și consum inutil al cotei 429.
    const locallyRecognizedSoundCues = items.filter(item => isStandaloneNonDialogueSoundCue(item.text));
    for (const item of locallyRecognizedSoundCues) {
        markIntentionalSoundCueSuppressed(item, translatedById, keyStates);
    }
    if (locallyRecognizedSoundCues.length) {
        console.log(`${c.cyan}[${stageLabel}] ${locallyRecognizedSoundCues.length} cue-uri sonore recunoscute local; omise fără cereri Gemini.${c.reset}`);
    }
    items = items.filter(item => !isStandaloneNonDialogueSoundCue(item.text));
    if (!items.length) {
        return { recoveredCount: 0, recoveredIds: [], failedItems: [], unresolvedItems: [], parsedAnyResponse: false, apiFailure: false };
    }
    const batches = chunkArray(items, FINAL_EMPTY_RECOVERY_BATCH_SIZE);
    const failedById = new Map();
    // Păstrăm separat numai ID-urile care au primit un răspuns JSON valid,
    // dar au fost omise sau respinse de validarea traducerii. Doar acestea
    // pot primi retry individual; JSON-ul malformat nu declanșează o rafală.
    const individualRetryById = new Map();
    const recoveredIds = [];
    let recoveredCount = 0;
    let parsedAnyResponse = false;
    let apiFailure = false;

    const rememberFailed = item => {
        const id = String(item.id);
        if (getIntentionallySuppressedTranslationIds(keyStates).has(id)) return;
        if (!String(translatedById[id] || '').replace(/<[^>]+>/g, '').trim()) {
            failedById.set(id, item);
        }
    };

    const processBatch = async (batch, depth, batchLabel, allowJsonRetry = true) => {
        if (!batch.length) return;
        if (apiFailure || keyStates._emptyRecoveryQuotaBlocked || keyStates._primary429CircuitOpen || keyStates._secondaryRecovery429Hold) {
            batch.forEach(rememberFailed);
            return;
        }

        let recoveryDict;
        try {
            const raw = await callGeminiWithKeyRotation(
                buildEmptyRecoveryPrompt(batch, false, stageLabel),
                keyStates,
                {
                    requestLabel: `${stageLabel} — ${batchLabel} (${batch.length} ID-uri)`,
                    responseSchema: buildTranslationResponseSchema(batch)
                }
            );
            recoveryDict = normalizeTranslationPayload(safeJsonParse(raw));
            parsedAnyResponse = true;
        } catch (error) {
            if (isRecoverableJsonParseError(error)) {
                if (allowJsonRetry) {
                    console.log(`${c.yellow}↻ [${stageLabel}] JSON invalid la ${batch.length} ID-uri; retry 1/1...${c.reset}`);
                    await sleep(FINAL_EMPTY_RECOVERY_JSON_RETRY_DELAY_MS);
                    try {
                        const retryRaw = await callGeminiWithKeyRotation(
                            buildEmptyRecoveryPrompt(batch, true, stageLabel),
                            keyStates,
                            {
                                requestLabel: `${stageLabel} — ${batchLabel} — JSON retry (${batch.length} ID-uri)`,
                                responseSchema: buildTranslationResponseSchema(batch)
                            }
                        );
                        recoveryDict = normalizeTranslationPayload(safeJsonParse(retryRaw));
                        parsedAnyResponse = true;
                    } catch (retryError) {
                        if (isRecoverableJsonParseError(retryError)) {
                            if (batch.length > 1 && depth < FINAL_EMPTY_RECOVERY_MAX_JSON_SPLIT_DEPTH) {
                                const middle = Math.ceil(batch.length / 2);
                                const left = batch.slice(0, middle);
                                const right = batch.slice(middle);
                                console.log(`${c.yellow}⚠ [${stageLabel}] JSON încă invalid; împart grupul ${batchLabel} în ${left.length}+${right.length}.${c.reset}`);
                                await processBatch(left, depth + 1, `${batchLabel}.a`, true);
                                await processBatch(right, depth + 1, `${batchLabel}.b`, true);
                            } else {
                                batch.forEach(rememberFailed);
                            }
                            return;
                        }
                        const quotaBlocked = markEmptyRecoveryQuotaBlock(keyStates, retryError);
                        const is429 = retryError?.isRateLimit429 === true || /\b429\b/i.test(String(retryError?.message || ''));
                        if (!is429) {
                            console.log(`${c.yellow}⚠ [${stageLabel}] API indisponibil la grupul ${batchLabel}: ${String(retryError?.message || retryError).slice(0, 200)}${quotaBlocked ? ' Recuperarea AI se oprește pentru această procesare.' : ''}${c.reset}`);
                        }
                        apiFailure = true;
                        batch.forEach(rememberFailed);
                        return;
                    }
                } else if (batch.length > 1 && depth < FINAL_EMPTY_RECOVERY_MAX_JSON_SPLIT_DEPTH) {
                    const middle = Math.ceil(batch.length / 2);
                    const left = batch.slice(0, middle);
                    const right = batch.slice(middle);
                    console.log(`${c.yellow}⚠ [${stageLabel}] JSON invalid; împart grupul ${batchLabel} în ${left.length}+${right.length}.${c.reset}`);
                    await processBatch(left, depth + 1, `${batchLabel}.a`, true);
                    await processBatch(right, depth + 1, `${batchLabel}.b`, true);
                    return;
                } else {
                    batch.forEach(rememberFailed);
                    return;
                }
            } else {
                const quotaBlocked = markEmptyRecoveryQuotaBlock(keyStates, error);
                const is429 = error?.isRateLimit429 === true || /\b429\b/i.test(String(error?.message || ''));
                if (!is429) {
                    console.log(`${c.yellow}⚠ [${stageLabel}] API indisponibil la grupul ${batchLabel}: ${String(error?.message || error).slice(0, 200)}${quotaBlocked ? ' Recuperarea AI se oprește pentru această procesare.' : ''}${c.reset}`);
                }
                apiFailure = true;
                batch.forEach(rememberFailed);
                return;
            }
        }

        const unresolved = [];
        const rejectionReasons = new Map();
        const markerRetryAttemptedIds = new Set();
        let intentionalSoundSkips = 0;
        let repeatedEmptyResponseSkips = 0;

        // Dacă Gemini folosește markerul interzis pentru dialog, reîncercăm o singură
        // dată ID-urile afectate împreună, cu instrucțiune de traducere obligatorie.
        // Nu împărțim apoi aceleași ID-uri în multe loturi: asta cauza rafala de cereri
        // observată în log și deschidea circuitul 429 înainte de recuperare.
        const markerRejectedItems = batch.filter(item => {
            const id = String(item.id);
            return !String(translatedById[id] || '').replace(/<[^>]+>/g, '').trim() &&
                isEmptyRecoverySoundCueSkip(recoveryDict[id]) &&
                !isStandaloneNonDialogueSoundCue(item.text);
        });
        if (markerRejectedItems.length) {
            markerRejectedItems.forEach(item => markerRetryAttemptedIds.add(String(item.id)));
            console.log(`${c.yellow}[${stageLabel}] ${markerRejectedItems.length} marker(e) de omitere respinse pentru replici neclasificate local ca cue sonor; o singură reîncercare grupată cu traducere obligatorie.${c.reset}`);
            try {
                const forcedRaw = await callGeminiWithKeyRotation(
                    buildEmptyRecoveryPrompt(markerRejectedItems, true, `${stageLabel} — traducere obligatorie`, true),
                    keyStates,
                    {
                        requestLabel: `${stageLabel} — traducere obligatorie (${markerRejectedItems.length} ID-uri)`,
                        responseSchema: buildTranslationResponseSchema(markerRejectedItems)
                    }
                );
                const forcedDict = normalizeTranslationPayload(safeJsonParse(forcedRaw));
                parsedAnyResponse = true;
                for (const item of markerRejectedItems) {
                    const id = String(item.id);
                    if (Object.prototype.hasOwnProperty.call(forcedDict, id)) {
                        recoveryDict[id] = forcedDict[id];
                    }
                }
            } catch (forcedError) {
                if (isRecoverableJsonParseError(forcedError)) {
                    console.log(`${c.yellow}[${stageLabel}] Răspunsul de recuperare obligatorie a fost JSON invalid; ID-urile rămân pentru QA FINAL, fără split suplimentar.${c.reset}`);
                } else {
                    const quotaBlocked = markEmptyRecoveryQuotaBlock(keyStates, forcedError);
                    const is429 = forcedError?.isRateLimit429 === true || /\b429\b/i.test(String(forcedError?.message || ''));
                    if (!is429) {
                        console.log(`${c.yellow}[${stageLabel}] Eroare API la traducerea obligatorie: ${String(forcedError?.message || forcedError).slice(0, 200)}${quotaBlocked ? ' Recuperarea AI se oprește pentru această procesare.' : ''}${c.reset}`);
                    }
                    apiFailure = true;
                    batch.forEach(rememberFailed);
                    return;
                }
            }
        }

        for (const item of batch) {
            const id = String(item.id);
            if (isEmptyRecoverySoundCueSkip(recoveryDict[id]) && isStandaloneNonDialogueSoundCue(item.text)) {
                markIntentionalSoundCueSuppressed(item, translatedById, keyStates);
                failedById.delete(id);
                individualRetryById.delete(id);
                intentionalSoundSkips++;
                continue;
            }
            if (getIntentionallySuppressedTranslationIds(keyStates).has(id)) {
                failedById.delete(id);
                individualRetryById.delete(id);
                continue;
            }
            const hasIdInResponse = Object.prototype.hasOwnProperty.call(recoveryDict, id);
            const recoveredValue = recoveryDict[id];
            if (batch.length <= FINAL_EMPTY_RECOVERY_BATCH_SIZE && hasIdInResponse &&
                typeof recoveredValue === 'string' && recoveredValue.trim() === '' &&
                !markerRetryAttemptedIds.has(id)) {
                // ID-ul a fost deja gol în traducerea principală, iar Empty Recovery
                // a întors din nou explicit text gol pentru el. Conform regulii cerute,
                // îl suprimăm aici și nu îl mai împărțim sau retrimitem individual.
                markIntentionalSoundCueSuppressed(item, translatedById, keyStates);
                failedById.delete(id);
                individualRetryById.delete(id);
                repeatedEmptyResponseSkips++;
                continue;
            }
            if (String(translatedById[id] || '').replace(/<[^>]+>/g, '').trim()) {
                failedById.delete(id);
                individualRetryById.delete(id);
                continue;
            }
            const assessment = assessEmptyRecoveryCandidate(item, recoveryDict[id]);
            if (assessment.ok) {
                translatedById[id] = assessment.candidate;
                recoveredCount++;
                recoveredIds.push(id);
                failedById.delete(id);
                individualRetryById.delete(id);
            } else {
                unresolved.push(item);
                failedById.set(id, item);
                if (markerRetryAttemptedIds.has(id)) {
                    individualRetryById.delete(id);
                } else {
                    individualRetryById.set(id, item);
                }
                const reason = assessment.reason || 'motiv necunoscut';
                rejectionReasons.set(reason, (rejectionReasons.get(reason) || 0) + 1);
            }
        }

        if (intentionalSoundSkips) {
            console.log(`${c.cyan}[${stageLabel}] ${intentionalSoundSkips} ID-uri marcate explicit ca descrieri sonore; lăsate goale intenționat și excluse din retry/QA.${c.reset}`);
        }
        if (repeatedEmptyResponseSkips) {
            console.log(`${c.cyan}[${stageLabel}] ${repeatedEmptyResponseSkips} ID-uri au primit din nou text explicit gol într-un lot mic; suprimate fără split, retry individual sau QA FINAL.${c.reset}`);
        }

        // JSON valid, dar ID-uri absente/inacceptabile: reluăm numai acele ID-uri.
        if (unresolved.length) {
            const reasonSummary = [...rejectionReasons.entries()].map(([reason, count]) => `${reason}: ${count}`).join('; ');
            console.log(`${c.yellow}[${stageLabel}] Răspuns pentru grupul ${batchLabel}: ${unresolved.length}/${batch.length} ID-uri încă neacceptate${reasonSummary ? ` (${reasonSummary})` : ''}.${c.reset}`);
        }
        const unresolvedEligibleForSplit = unresolved.filter(item => !markerRetryAttemptedIds.has(String(item.id)));
        if (unresolvedEligibleForSplit.length > 1 && depth < FINAL_EMPTY_RECOVERY_MAX_JSON_SPLIT_DEPTH && !apiFailure) {
            const middle = Math.ceil(unresolvedEligibleForSplit.length / 2);
            const left = unresolvedEligibleForSplit.slice(0, middle);
            const right = unresolvedEligibleForSplit.slice(middle);
            console.log(`${c.yellow}⚠ [${stageLabel}] ${unresolvedEligibleForSplit.length} ID-uri lipsă sau respinse; reîncerc în loturi ${left.length}+${right.length}.${c.reset}`);
            await processBatch(left, depth + 1, `${batchLabel}.missing-a`, true);
            await processBatch(right, depth + 1, `${batchLabel}.missing-b`, true);
        } else if (unresolved.length) {
            const noMoreRetry = unresolved.length - unresolvedEligibleForSplit.length;
            if (noMoreRetry > 0) {
                console.log(`${c.yellow}[${stageLabel}] ${noMoreRetry} ID-uri au epuizat reîncercarea grupată pentru marker; rămân pentru QA FINAL, fără cereri suplimentare în rafală.${c.reset}`);
            }
        }
    };

    console.log(`${c.cyan}[${stageLabel}] Procesez ${items.length} ID-uri în ${batches.length} grupuri de maximum ${FINAL_EMPTY_RECOVERY_BATCH_SIZE}.${c.reset}`);
    for (let index = 0; index < batches.length; index++) {
        await processBatch(batches[index], 0, `grup ${index + 1}/${batches.length}`, true);
        if (apiFailure || keyStates._emptyRecoveryQuotaBlocked || keyStates._primary429CircuitOpen || keyStates._secondaryRecovery429Hold) {
            for (let pendingIndex = index + 1; pendingIndex < batches.length; pendingIndex++) {
                batches[pendingIndex].forEach(rememberFailed);
            }
            break;
        }
    }

    return {
        recoveredCount,
        recoveredIds,
        failedItems: [...individualRetryById.values()],
        unresolvedItems: [...failedById.values()],
        parsedAnyResponse,
        apiFailure
    };
}

// Recuperare locală, fără apel API: refolosește traducerea deja validată a unei
// replici cu text-sursă identic. Nu ghicește și nu folosește potriviri aproximative.
function normalizeLocalRecoverySource(text) {
    return String(text || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .normalize('NFC')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeLocalRecoveryTranslation(text) {
    return String(text || '')
        .replace(/<[^>]+>/g, ' ')
        .normalize('NFC')
        .replace(/\s+/g, ' ')
        .trim();
}

function recoverEmptyTranslationsLocally(allItems, emptyItems, translatedById, stageLabel) {
    const bySource = new Map();

    for (const sourceItem of allItems) {
        const sourceKey = normalizeLocalRecoverySource(sourceItem.text);
        if (!sourceKey || isEffectivelyEmptySubtitleText(sourceItem.text) || isJunkOrInterjection(sourceItem.text)) continue;

        const current = String(translatedById[String(sourceItem.id)] || '');
        if (!current.replace(/<[^>]+>/g, '').trim()) continue;

        const assessment = assessEmptyRecoveryCandidate(sourceItem, current);
        if (!assessment.ok) continue;

        const translationKey = normalizeLocalRecoveryTranslation(assessment.candidate);
        if (!translationKey) continue;

        if (!bySource.has(sourceKey)) bySource.set(sourceKey, new Map());
        const translations = bySource.get(sourceKey);
        if (!translations.has(translationKey)) {
            translations.set(translationKey, { candidate: assessment.candidate, sourceId: String(sourceItem.id) });
        }
    }

    const recoveredIds = [];
    const remaining = [];
    for (const item of emptyItems) {
        const id = String(item.id);
        const sourceKey = normalizeLocalRecoverySource(item.text);
        const matches = bySource.get(sourceKey);

        // Dacă aceeași sursă are mai multe traduceri distincte deja existente,
        // considerăm cazul ambiguu și nu alegem una arbitrar.
        if (!sourceKey || !matches || matches.size !== 1) {
            remaining.push(item);
            continue;
        }

        const match = [...matches.values()][0];
        const assessment = assessEmptyRecoveryCandidate(item, match.candidate);
        if (!assessment.ok) {
            remaining.push(item);
            continue;
        }

        translatedById[id] = assessment.candidate;
        recoveredIds.push(id);
        console.log(`${c.green}✔ [${stageLabel} Local] ID ${id} recuperat din traducerea existentă a ID-ului ${match.sourceId}; fără apel Gemini.${c.reset}`);
    }

    if (recoveredIds.length) {
        console.log(`${c.green}✔ [${stageLabel} Local] Recuperate local: ${recoveredIds.length}/${emptyItems.length}.${c.reset}`);
    }
    return { recoveredIds, remaining };
}

function markEmptyRecoveryQuotaBlock(keyStates, error) {
    const message = String(error?.message || error || '');
    const quotaError = error?.isRateLimit429 === true || /\b429\b/i.test(message) || /resource has been exhausted|quota exceeded/i.test(message);
    if (!quotaError) return false;

    // O eroare de cotă pentru un singur proiect nu blochează recuperarea prin
    // celelalte proiecte. Oprim numai dacă toate proiectele rămase sunt marcate
    // cu cotă zilnică epuizată (sau au fost dezactivate ca invalide).
    if (error?.isPermanentQuotaBlock === true) {
        keyStates._emptyRecoveryQuotaBlocked = true;
        return true;
    }
    const now = Date.now();
    const nonDisabled = keyStates.filter(state => {
        const lane = getLaneForKeyState(state);
        return !state.disabled && !lane.disabled;
    });
    const allDailyBlocked = nonDisabled.length > 0 && nonDisabled.every(state => {
        const lane = getLaneForKeyState(state);
        return Math.max(Number(state.dailyQuotaUntil || 0), Number(lane.dailyQuotaUntil || 0)) > now;
    });
    if (allDailyBlocked || nonDisabled.length === 0) {
        keyStates._emptyRecoveryQuotaBlocked = true;
        return true;
    }
    return false;
}

async function retryEmptyTranslationIndividually(item, translatedById, keyStates, stageLabel = 'Empty Recovery') {
    const id = String(item.id);
    if (keyStates._emptyRecoveryQuotaBlocked || keyStates._emptyRecoveryIndividualRetriesDisabled) return false;

    if (!(keyStates._emptyRecoveryAttemptedIds instanceof Set)) {
        keyStates._emptyRecoveryAttemptedIds = new Set();
    }
    // Marcăm ID-ul înaintea apelului: aceeași replică nu va primi încă un retry
    // automat în etapa Final Empty Recovery.
    keyStates._emptyRecoveryAttemptedIds.add(id);

    const prompt = buildEmptyRecoveryPrompt([item], false, `${stageLabel} individual`);

    try {
        const retryRaw = await callGeminiWithKeyRotation(prompt, keyStates, {
            timeout: 30000,
            requestLabel: `${stageLabel} — ID ${id}`,
            responseSchema: buildTranslationResponseSchema([item])
        });
        const retryJson = safeJsonParse(retryRaw);
        const retryDict = normalizeTranslationPayload(retryJson);
        if (isEmptyRecoverySoundCueSkip(retryDict[id]) && isStandaloneNonDialogueSoundCue(item.text)) {
            markIntentionalSoundCueSuppressed(item, translatedById, keyStates);
            console.log(`${c.cyan}[${stageLabel} Retry] ID ${id} marcat ca descriere sonoră; lăsat gol intenționat, fără alte retry-uri.${c.reset}`);
            return 'suppressed';
        }
        const assessment = assessEmptyRecoveryCandidate(item, retryDict[id]);

        if (!assessment.ok) {
            // ID-ul este raportat o singură dată, dacă rămâne gol, în QA FINAL.
            return false;
        }

        translatedById[id] = assessment.candidate;
        console.log(`${c.green}✔ [${stageLabel} Retry] ID ${id} recuperat prin cerere individuală.${c.reset}`);
        return true;
    } catch (error) {
        const is429 = error?.isRateLimit429 === true || /\b429\b/i.test(String(error?.message || ''));
        if (is429) {
            register429(
                keyStates,
                Number(error.retryAfterMs) || 15000,
                error.isProjectQuota429 === true
            );
        }
        markEmptyRecoveryQuotaBlock(keyStates, error);
        // Eroarea API (inclusiv 429) este deja înregistrată la nivelul cererii;
        // ID-urile care rămân goale sunt raportate împreună la QA FINAL.
        return false;
    }
}

async function recoverEmptyTranslationsFinal(items, translatedById, keyStates) {
    const detectedEmptyTranslations = items.filter(item => {
        if (item.musicOnly) return false;
        const id = String(item.id);
        if (getIntentionallySuppressedTranslationIds(keyStates).has(id)) return false;
        const originalClean = isEffectivelyEmptySubtitleText(item.text) ? '' : String(item.text || '').replace(/<[^>]+>/g, '').trim();
        if (!originalClean || isJunkOrInterjection(item.text) || isOnlyStandaloneFillerSequence(item.text) || isStandaloneNonDialogueSoundCue(item.text)) return false;
        const translated = translatedById[id];
        return !String(translated || '').replace(/<[^>]+>/g, '').trim();
    });

    if (!detectedEmptyTranslations.length) return { detected: 0, recovered: 0 };

    // Încercăm recuperarea locală ÎNAINTE de verificarea cotei: reutilizarea unei
    // traduceri existente nu consumă Gemini și rămâne permisă chiar după un 429.
    const localRecovery = recoverEmptyTranslationsLocally(
        items, detectedEmptyTranslations, translatedById, 'Final Empty Recovery'
    );
    let recoveredCount = localRecovery.recoveredIds.length;
    const recoveredIds = [...localRecovery.recoveredIds];
    const unresolvedAfterLocal = detectedEmptyTranslations.filter(item =>
        !String(translatedById[String(item.id)] || '').replace(/<[^>]+>/g, '').trim()
    );

    if (!unresolvedAfterLocal.length) {
        console.log(`${c.green}✔ [Final Empty Recovery] Toate cele ${detectedEmptyTranslations.length} traduceri goale au fost recuperate local.${c.reset}`);
        return { detected: detectedEmptyTranslations.length, recovered: recoveredCount };
    }

    // După o blocare 429, etapa locală a rulat deja; nu pornim alt apel AI.
    if (keyStates._emptyRecoveryQuotaBlocked || keyStates._primary429CircuitOpen || keyStates._secondaryRecovery429Hold) {
        if ((keyStates._primary429CircuitOpen || keyStates._secondaryRecovery429Hold) && !keyStates._finalRecoveryAiSkipLogged) {
            keyStates._finalRecoveryAiSkipLogged = true;
            console.log(`${c.yellow}[Final Empty Recovery] Recuperarea locală s-a încheiat; apelul AI este omis deoarece circuitul 429 este deschis.${c.reset}`);
        }
        return { detected: detectedEmptyTranslations.length, recovered: recoveredCount };
    }

    const attemptedIds = keyStates._emptyRecoveryAttemptedIds instanceof Set
        ? keyStates._emptyRecoveryAttemptedIds
        : new Set();
    const previouslyRetried = unresolvedAfterLocal.filter(item => attemptedIds.has(String(item.id)));
    // ID-urile deja încercate sunt lăsate pentru raportul unic QA FINAL dacă rămân goale.
    const emptyTranslations = unresolvedAfterLocal.filter(item => !attemptedIds.has(String(item.id)));
    if (!emptyTranslations.length) {
        return { detected: detectedEmptyTranslations.length, recovered: recoveredCount };
    }

    const recoveryBatches = chunkArray(emptyTranslations, FINAL_EMPTY_RECOVERY_BATCH_SIZE);
    console.log(`${c.cyan}[Final Empty Recovery] Încerc recuperarea AI pentru ${emptyTranslations.length} ID-uri în ${recoveryBatches.length} grupuri de maximum ${FINAL_EMPTY_RECOVERY_BATCH_SIZE}.${c.reset}`);

    // O eroare de transport/API oprește restul acestei etape. Astfel nu multiplicăm
    // apelurile în timpul unui 503/429; numai erorile de format JSON sunt izolate prin split.
    let stopAfterRecoveryApiFailure = false;

    const buildRecoveryPrompt = (batch, strictJsonRetry = false, forceTranslate = false) =>
        buildEmptyRecoveryPrompt(batch, strictJsonRetry, 'Final Empty Recovery', forceTranslate);

    const requestRecoveryBatch = async (batch, batchLabel, strictJsonRetry = false, forceTranslate = false) => {
        const raw = await callGeminiWithKeyRotation(
            buildRecoveryPrompt(batch, strictJsonRetry, forceTranslate),
            keyStates,
            {
                timeout: 20000,
                allowAfter429Hold: true,
                requestLabel: `Final Empty Recovery — ${batchLabel} (${batch.length} ID-uri)`,
                responseSchema: buildTranslationResponseSchema(batch)
            }
        );
        return normalizeTranslationPayload(safeJsonParse(raw));
    };

    const splitAndRecover = async (batch, depth, batchLabel, reason) => {
        if (stopAfterRecoveryApiFailure || batch.length <= 1 || depth >= FINAL_EMPTY_RECOVERY_MAX_JSON_SPLIT_DEPTH) {
            console.log(`${c.yellow}[Final Empty Recovery] ${reason}; ${batch.length} ID-uri rămân pentru raportul QA FINAL.${c.reset}`);
            return;
        }
        const middle = Math.ceil(batch.length / 2);
        const left = batch.slice(0, middle);
        const right = batch.slice(middle);
        console.log(`${c.yellow}[Final Empty Recovery] ${reason} la ${batch.length} ID-uri; împart în ${left.length}+${right.length}.${c.reset}`);
        await processRecoveryBatch(left, depth + 1, `${batchLabel}.a`, false);
        if (!stopAfterRecoveryApiFailure) {
            await processRecoveryBatch(right, depth + 1, `${batchLabel}.b`, false);
        }
    };

    const processRecoveryBatch = async (batch, depth, batchLabel, allowSameBatchJsonRetry) => {
        if (!batch.length || stopAfterRecoveryApiFailure) return;
        if (keyStates._emptyRecoveryQuotaBlocked || keyStates._primary429CircuitOpen || keyStates._secondaryRecovery429Hold) {
            stopAfterRecoveryApiFailure = true;
            return;
        }

        let recoveryDict;
        try {
            recoveryDict = await requestRecoveryBatch(batch, batchLabel, false);
        } catch (error) {
            if (isRecoverableJsonParseError(error)) {
                if (allowSameBatchJsonRetry) {
                    console.log(`${c.yellow}↻ [Final Empty Recovery] JSON invalid la ${batch.length} ID-uri; retry 1/1...${c.reset}`);
                    await sleep(FINAL_EMPTY_RECOVERY_JSON_RETRY_DELAY_MS);
                    try {
                        recoveryDict = await requestRecoveryBatch(batch, batchLabel, true);
                    } catch (retryError) {
                        if (isRecoverableJsonParseError(retryError)) {
                            await splitAndRecover(batch, depth, batchLabel, 'JSON invalid după retry');
                            return;
                        }
                        const quotaBlocked = markEmptyRecoveryQuotaBlock(keyStates, retryError);
                        const is429 = retryError?.isRateLimit429 === true || /\b429\b/i.test(String(retryError?.message || ''));
                        if (!is429) {
                            console.log(`${c.yellow}[Final Empty Recovery] Eroare API la grupul ${batchLabel}: ${String(retryError?.message || retryError).slice(0, 240)}${quotaBlocked ? ' Recuperarea AI se oprește pentru această procesare.' : ''}${c.reset}`);
                        }
                        stopAfterRecoveryApiFailure = true;
                        return;
                    }
                } else {
                    await splitAndRecover(batch, depth, batchLabel, 'JSON invalid');
                    return;
                }
            } else {
                const quotaBlocked = markEmptyRecoveryQuotaBlock(keyStates, error);
                const is429 = error?.isRateLimit429 === true || /\b429\b/i.test(String(error?.message || ''));
                if (!is429) {
                    console.log(`${c.yellow}[Final Empty Recovery] Eroare API la grupul ${batchLabel}: ${String(error?.message || error).slice(0, 240)}${quotaBlocked ? ' Recuperarea AI se oprește pentru această procesare.' : ''}${c.reset}`);
                }
                // În special pentru 503, nu lansăm grupuri suplimentare după epuizarea
                // retry-urilor API. Traducerile deja recuperate rămân păstrate.
                stopAfterRecoveryApiFailure = true;
                return;
            }
        }

        const unresolved = [];
        const markerRetryAttemptedIds = new Set();
        let intentionalSoundSkips = 0;

        // La recuperarea finală aplicăm aceeași limită: markerul invalid pentru
        // dialog primește o singură reîncercare grupată, nu split-uri în cascadă.
        const markerRejectedItems = batch.filter(item => {
            const id = String(item.id);
            return !String(translatedById[id] || '').replace(/<[^>]+>/g, '').trim() &&
                isEmptyRecoverySoundCueSkip(recoveryDict[id]) &&
                !isStandaloneNonDialogueSoundCue(item.text);
        });
        if (markerRejectedItems.length) {
            markerRejectedItems.forEach(item => markerRetryAttemptedIds.add(String(item.id)));
            console.log(`${c.yellow}[Final Empty Recovery] ${markerRejectedItems.length} marker(e) de omitere respinse; o singură reîncercare grupată cu traducere obligatorie.${c.reset}`);
            try {
                const forcedDict = await requestRecoveryBatch(
                    markerRejectedItems,
                    `${batchLabel} — traducere obligatorie`,
                    true,
                    true
                );
                for (const item of markerRejectedItems) {
                    const id = String(item.id);
                    if (Object.prototype.hasOwnProperty.call(forcedDict, id)) {
                        recoveryDict[id] = forcedDict[id];
                    }
                }
            } catch (forcedError) {
                if (isRecoverableJsonParseError(forcedError)) {
                    console.log(`${c.yellow}[Final Empty Recovery] JSON invalid la traducerea obligatorie; ID-urile rămân pentru QA FINAL, fără split suplimentar.${c.reset}`);
                } else {
                    const quotaBlocked = markEmptyRecoveryQuotaBlock(keyStates, forcedError);
                    const is429 = forcedError?.isRateLimit429 === true || /\b429\b/i.test(String(forcedError?.message || ''));
                    if (!is429) {
                        console.log(`${c.yellow}[Final Empty Recovery] Eroare API la traducerea obligatorie: ${String(forcedError?.message || forcedError).slice(0, 240)}${quotaBlocked ? ' Recuperarea AI se oprește pentru această procesare.' : ''}${c.reset}`);
                    }
                    stopAfterRecoveryApiFailure = true;
                    return;
                }
            }
        }

        for (const item of batch) {
            const id = String(item.id);
            if (isEmptyRecoverySoundCueSkip(recoveryDict[id]) && isStandaloneNonDialogueSoundCue(item.text)) {
                markIntentionalSoundCueSuppressed(item, translatedById, keyStates);
                intentionalSoundSkips++;
                continue;
            }
            if (getIntentionallySuppressedTranslationIds(keyStates).has(id)) continue;
            if (String(translatedById[id] || '').replace(/<[^>]+>/g, '').trim()) continue;
            const assessment = assessEmptyRecoveryCandidate(item, recoveryDict[id]);
            if (assessment.ok) {
                translatedById[id] = assessment.candidate;
                recoveredCount++;
                recoveredIds.push(id);
            } else {
                unresolved.push(item);
            }
        }

        if (intentionalSoundSkips) {
            console.log(`${c.cyan}[Final Empty Recovery] ${intentionalSoundSkips} ID-uri marcate ca descrieri sonore și scoase din retry/QA.${c.reset}`);
        }

        // Dacă JSON-ul este valid, dar lipsesc rezultate sau unele texte nu trec
        // validarea, reluăm numai ID-urile respective în grupuri mai mici.
        if (unresolved.length) {
            const unresolvedEligibleForSplit = unresolved.filter(item => !markerRetryAttemptedIds.has(String(item.id)));
            if (depth < FINAL_EMPTY_RECOVERY_MAX_JSON_SPLIT_DEPTH && unresolvedEligibleForSplit.length > 0) {
                await splitAndRecover(unresolvedEligibleForSplit, depth, batchLabel, `${unresolvedEligibleForSplit.length} ID-uri lipsă sau respinse după JSON valid`);
            } else {
                const noMoreRetry = unresolved.length - unresolvedEligibleForSplit.length;
                console.log(`${c.yellow}[Final Empty Recovery] Grupul ${batchLabel}: ${unresolved.length} ID-uri nu au trecut validarea; ${noMoreRetry ? `${noMoreRetry} după reîncercarea obligatorie` : ''} rămân pentru QA FINAL.${c.reset}`);
            }
        }
    };

    for (let batchIndex = 0; batchIndex < recoveryBatches.length; batchIndex++) {
        if (stopAfterRecoveryApiFailure) break;
        await processRecoveryBatch(
            recoveryBatches[batchIndex],
            0,
            `grup ${batchIndex + 1}/${recoveryBatches.length}`,
            true
        );
    }

    const intentionallySuppressedCount = detectedEmptyTranslations.filter(item =>
        getIntentionallySuppressedTranslationIds(keyStates).has(String(item.id))
    ).length;
    const recoveryEligibleCount = Math.max(0, detectedEmptyTranslations.length - intentionallySuppressedCount);
    const remainingEmpty = detectedEmptyTranslations.filter(item =>
        !getIntentionallySuppressedTranslationIds(keyStates).has(String(item.id)) &&
        !String(translatedById[String(item.id)] || '').replace(/<[^>]+>/g, '').trim()
    );
    const recoveredSuffix = recoveredIds.length ? ` (ID: ${recoveredIds.join(', ')})` : '';
    if (remainingEmpty.length === 0) {
        console.log(`${c.green}✔ [Final Empty Recovery] Recuperate: ${recoveredCount}/${recoveryEligibleCount}; omise intenționat: ${intentionallySuppressedCount}${recoveredSuffix}.${c.reset}`);
    } else {
        console.log(`${c.yellow}[Final Empty Recovery] Recuperate: ${recoveredCount}/${recoveryEligibleCount}; omise intenționat: ${intentionallySuppressedCount}; încă fără traducere: ${remainingEmpty.length}.${c.reset}`);
    }
    return { detected: recoveryEligibleCount, recovered: recoveredCount };
}

// ============================================================
// MAJUSCULE LA FRAGMENTELE CONTINUATE
// Dacă blocul englez continuă propoziția anterioară (începe cu literă mică, iar
// blocul precedent nu s-a încheiat cu punct), cuvintele funcționale de la începutul
// traducerii (Și, Iar, Dar, Să, Mai, De...) trec la literă mică. Folosește o listă
// închisă de cuvinte, ca să nu atingă niciodată nume proprii.
// ============================================================

const CONTINUATION_FUNCTION_WORDS = new Set([
    'și', 'iar', 'dar', 'sau', 'să', 'că', 'care', 'ce', 'cine', 'cum', 'când', 'unde', 'cât',
    'dacă', 'ca', 'de', 'pe', 'la', 'în', 'din', 'cu', 'pentru', 'prin', 'fără', 'despre',
    'după', 'înainte', 'către', 'între', 'mai', 'apoi', 'atunci', 'doar', 'chiar', 'tot',
    'totul', 'toți', 'toate', 'ceva', 'așa', 'nu', 'un', 'cea', 'cel', 'cei', 'cele', 'mă', 'te',
    'se', 'ne', 'vă', 'îmi', 'îți', 'își',
    // Cuvinte frecvente care apăreau cu majusculă după o frază neîncheiată
    // („... de când am murit / Acum mai bine de trei secole”).
    'acum', 'este', 'sunt', 'era', 'erau', 'a', 'au', 'ar', 'va', 'vor', 'o', 'nici', 'încă',
    'într-o', 'într-un', 'dintr-o', 'dintr-un', 'oricum', 'acolo', 'aici', 'atât', 'atâta',
    'mult', 'foarte', 'prea', 'deja', 'încât', 'fiindcă', 'deși', 'însă', 'ori', 'fie'
]);

// Vocabular de cuvinte scrise cu literă mică în traducerea curentă: dacă un cuvânt apare
// și cu literă mică în același fișier, nu este nume propriu și poate trece la literă mică.
function buildLowercaseVocabulary(translatedById) {
    const vocab = new Set();
    for (const value of Object.values(translatedById || {})) {
        const matches = String(value || '').match(/(?<![\p{L}\p{N}])\p{Ll}[\p{L}-]*/gu) || [];
        for (const token of matches) vocab.add(token);
    }
    return vocab;
}

function isContinuationBlock(prevEnglish, currentEnglish) {
    const cur = String(currentEnglish || '').replace(/<[^>]+>/g, '').trim();
    const prev = String(prevEnglish || '').replace(/<[^>]+>/g, '').trim();
    if (!cur || !prev) return false;
    if (/^[-–—]/.test(cur)) return false;
    const body = cur.replace(/^[.…\s"'“‘(\[]+/, '');
    if (!/^[a-z]/.test(body)) return false;
    if (/(?<!\.)[.!?]["”')\]]*$/.test(prev)) return false;
    return true;
}

function applyContinuationCase(items, translatedById) {
    let changed = 0;
    const lowercaseVocabulary = buildLowercaseVocabulary(translatedById);
    for (let i = 1; i < items.length; i++) {
        if (items[i - 1].musicOnly || items[i].musicOnly) continue;
        if (!isContinuationBlock(items[i - 1].text, items[i].text)) continue;

        const id = String(items[i].id);
        const current = String(translatedById[id] || '');
        const previousRo = String(translatedById[String(items[i - 1].id)] || '').trim();
        if (!current.trim() || !previousRo) continue;
        if (/(?<!\.)[.!?]["”]?$/.test(previousRo)) continue;
        if (/^\s*[-–—]/.test(current)) continue;

        const match = current.match(/^(\s*[.…"„“]*\s*)([A-ZĂÂÎȘȚ])([a-zăâîșț]*)/);
        if (!match) continue;
        const word = match[2] + match[3];
        const previousEnglish = String(items[i - 1].text || '').replace(/<[^>]+>/g, ' ').trim();
        const currentEnglish = String(items[i].text || '').replace(/<[^>]+>/g, ' ').trim();
        const progressiveContinuation = /\b(?:was|were|is|are)\s*$/i.test(previousEnglish) && /^[a-z]+ing\b/i.test(currentEnglish);
        const lowerWord = word.toLowerCase();
        // Gerunziu românesc („Așteptând”, „Știind”) după o frază neîncheiată, când și sursa începe cu „-ing”.
        const gerundContinuation = /^[a-z]+ing\b/i.test(currentEnglish) && /(?:ând|ind)$/u.test(lowerWord);
        // Cuvânt comun: apare și cu literă mică în restul traducerii (deci nu este nume propriu).
        const commonWord = word.length >= 2 && lowercaseVocabulary.has(lowerWord);
        if (!CONTINUATION_FUNCTION_WORDS.has(lowerWord) && !progressiveContinuation && !gerundContinuation && !commonWord) continue;

        translatedById[id] = match[1] + match[2].toLowerCase() + match[3] + current.slice(match[0].length);
        changed++;
    }
    console.log(`${c.green}✔ [Continuări] ${changed} fragmente continuate au primit literă mică la început.${c.reset}`);
    return changed;
}


// ============================================================
// NORMALIZARE CONSERVATOARE A MAJUSCULELOR ÎN MIJLOCUL FRAZEI
// Corectează doar cuvinte românești uzuale dintr-o listă explicită, când apar
// cu inițială mare după text fără punctuație de încheiere. Nu atinge începutul
// replicii, începutul unei propoziții, acronimele sau cuvintele care nu sunt
// în lista sigură (de ex. nume proprii necunoscute).
// ============================================================
const COMMON_ROMANIAN_MID_SENTENCE_WORDS = new Set((`
    acesta aceasta aceștia acestea acest acea acei acele acelea acela acelora
    acelasi aceeași aceleași asemenea alt alta alte alți altor altă altul altele
    am ai a are ar as avem aveți aveau avea aveam aveați avut fiind fost este e sunt
    suntem sunteți erau era erai eram erați fi fie fii fiind fusesem fusese
    fac faci face facem faceți fac ei făcut făcută făcute făcuți făcea făceau
    pot poți poate putem puteți pot putea puteam puteți puteați putea
    vreau vrei vrea vrem vreți vor vrea voiam voiai voia voiau vrut vrută
    trebuie trebuia trebuiau trebuit trebuiește pare părea par păreau
    și iar dar sau însă deci fiindcă deoarece pentru că să ca decât dacă
    când cum unde cine ce care că cât câți câte câtva câteva câțiva
    toate toți tot toată toată tuturor tuturor fiecare fiecăruia fiecarei
    nimeni nimic cineva ceva oricine orice altcineva altceva însuși însăși
    un una unele unul unei unor niște orice oricare vreun vreuna vreunul
    mă te se ne vă îl o îl își îmi îți îi lor lui ei mea meu mei mele
    tău ta tale tăi său sa sale săi noastră nostru noștri noastre voastră
    vostru voștri voastre dumneavoastră dumneata dumnealui dumneaei
    aici acolo apoi acum atunci astăzi ieri mâine deja încă iarăși mereu
    nici numai doar chiar foarte prea mult multe mulți multă puțin puține
    puțini mai mai mult mai puțin aproape departe bine rău poate sigur
    absolut aproape destul suficient aproape astfel așa altfel totuși
    în întru din dintre spre către până după înainte peste sub lângă
    fără despre contra între prin pe la cu asupra afară înăuntru
    acesta aici acolo acasă undeva nicăieri oriunde pretutindeni
    nu da ba oare încă nici niciodată întotdeauna uneori deseori rar
    apoi astfel asemenea altminteri tocmai măcar măcară poate bineînțeles
    lucru lucruri lucrul lucrurile treabă treaba treburile problema probleme
    problemele persoană persoane omul oameni omului oamenii femeie femeia
    femei bărbat bărbatul bărbați copil copii copilul copiii familie familia
    viață viața vieți zile ziua zilele noapte noaptea dimineață seară
    bani timpul timp vremea loc locul locuri locurile casă casa case
    mașină mașina mașini ușă ușa uși drum drumul drumuri lume lumea
    lumei parte partea părți fel felul lucru lucruri nume numele
    ochi ochii mână mâna mâini cap capul față fața spate corp
    voce vocea mâine ieri azi acum înainte după aceea totul nimic
    adevăr adevărul minciună minciuna motiv motivul motive întâmplare
    întâmplarea situație situația situații moment momentul momente
    întrebare întrebarea întrebări răspuns răspunsul răspunsuri
    idee ideea idei lucru chestie chestia chestii gen felul parte
    început începutul sfârșit sfârșitul final finalul punct cazul
    caz cazuri motiv motive motivul rezultat rezultate plan planul
    nevoie nevoie nevoiele nevoie de ajutor ajutor ajutorul
    lucru important importantă importante importantul posibil posibilă
    imposibil adevărat adevărată adevărate fals falsă bine rău
    nou nouă noi noul vechi veche vechiul mare marele mari mic mică
    mici bun bună bune buni rău rea rele răi frumos frumoasă
    sigur sigură sigură clar clară clară normal normală normale
    simplu simplă simplu simplă greu grea ușor ușoară diferit
    diferită diferite corect corectă greșit greșită interesant
    interesantă gata liber liberă ocupat ocupată obosit obosită
    fericit fericită supărat supărată trist tristă mort moartă viu vie
    primul prima primul primele primii ultima ultimul ultimele ultimii
    altădată între timp înapoi afară înainte în plus în schimb
    imediat repede încet deja poate probabil evident sigur desigur
    oricum totuși așadar prin urmare de fapt de obicei în general
    măcar aproape foarte chiar atât tocmai inclusiv exclusiv
    apoi acum aici acolo sus jos înapoi înainte în față în urmă
    nu-i n-am n-ai n-are n-avem n-aveți n-au s-a s-au mi-a ți-a
    ți-am mi-am i-am i-a le-a l-a l-au într-o într-un dintr-o dintr-un
`).trim().split(/\s+/));

function applyMidSentenceCapitalizationFixes(items, translatedById) {
    let changedWords = 0;
    let changedSubtitles = 0;
    const terminalPunctuation = /[.!?…:]+["'’”»)}\]]*$/u;
    const openingQuoteOrBracket = /["'„“«‘(\[]\s*$/u;
    const speakerDashAtLineStart = /(?:^|\n)\s*[-–—]\s*$/u;

    for (const item of items) {
        if (item.musicOnly) continue;
        const id = String(item.id);
        const original = String(translatedById[id] || '');
        if (!original.trim()) continue;

        let localChanges = 0;
        const normalized = original.replace(/(?<![\p{L}\p{N}_])([A-ZĂÂÎȘȚ][a-zăâîșț]+)(?![\p{L}\p{N}_])/gu,
            (wholeWord, _first, offset) => {
                // Nu procesăm atribute sau nume de tag HTML.
                const beforeRaw = original.slice(0, offset);
                if (beforeRaw.lastIndexOf('<') > beforeRaw.lastIndexOf('>')) return wholeWord;

                const word = wholeWord.toLocaleLowerCase('ro-RO');
                if (!COMMON_ROMANIAN_MID_SENTENCE_WORDS.has(word)) return wholeWord;

                const before = beforeRaw.replace(/<[^>]*>/g, '').trimEnd();
                // Cuvântul este la începutul replicii/fragmentului, nu în mijlocul frazei.
                if (!/[\p{L}\p{N}]/u.test(before)) return wholeWord;
                // Nu schimbăm începuturile de propoziție sau începutul unui citat/paranteze.
                if (terminalPunctuation.test(before) || openingQuoteOrBracket.test(before) || speakerDashAtLineStart.test(before)) {
                    return wholeWord;
                }

                localChanges++;
                return word;
            });

        if (localChanges) {
            translatedById[id] = normalized;
            changedWords += localChanges;
            changedSubtitles++;
        }
    }

    if (changedWords) {
        console.log(`${c.green}[Majuscule în frază] Corectate ${changedWords} inițiale nejustificat de mari în ${changedSubtitles} replici.${c.reset}`);
    }
    return changedWords;
}


// ============================================================
// MOTORUL PRINCIPAL DE TRADUCERE SRT
// ============================================================

async function translateSrtWithGemini(srtText, apiKeys, qaStatus = null, mediaContext = '') {
    const sourceBlockCount = (String(srtText || '').match(/-->/g) || []).length;
    const parseStats = { fillerBlocksFiltered: 0, otherBlocksFiltered: 0, invalidBlocksSkipped: 0, duplicateIdsRenumbered: 0 };
    const items = parseSrt(srtText, parseStats);
    // Citit de buildTranslationPrompt; același array `items` este transmis tuturor calupurilor.
    items.mediaContext = String(mediaContext || '');

    const verbatimNumericCueCount = items.filter(item => isNumericVerbatimCue(item.text)).length;
    const sentToGeminiCount = items.filter(item => !isNumericVerbatimCue(item.text) && !item.musicOnly).length;
    const musicSegmentCount = parseStats.musicSegmentsRemovedBeforeTranslation || 0;
    const musicOnlyCueCount = parseStats.musicOnlyBlocksRemovedBeforeTranslation || 0;
    const accountingDelta = sourceBlockCount - items.length - parseStats.fillerBlocksFiltered - parseStats.otherBlocksFiltered - parseStats.invalidBlocksSkipped - parseStats.nonDialogueBlocksFiltered - musicOnlyCueCount;
    console.log(`${c.cyan}[SRT] Sursă: ${sourceBlockCount} blocuri | către Gemini: ${sentToGeminiCount} | coduri numerice copiate exact: ${verbatimNumericCueCount} | interjecții eliminate înainte: ${parseStats.fillerBlocksFiltered}${musicSegmentCount ? ` | versuri muzicale eliminate înainte de Gemini: ${musicSegmentCount} segmente` : ''}${musicOnlyCueCount ? ` | blocuri exclusiv muzicale eliminate înainte de Gemini: ${musicOnlyCueCount}` : ''}${parseStats.nonDialogueBlocksFiltered ? ` | blocuri eliminate prin filtrarea parantezelor/cue-urilor: ${parseStats.nonDialogueBlocksFiltered}` : ''}${parseStats.nonDialogueSegmentsRemoved ? ` | segmente între paranteze/cue-uri eliminate: ${parseStats.nonDialogueSegmentsRemoved}` : ''}${parseStats.otherBlocksFiltered ? ` | alte blocuri goale/curățate: ${parseStats.otherBlocksFiltered}` : ''}${parseStats.invalidBlocksSkipped ? ` | blocuri SRT invalide ignorate: ${parseStats.invalidBlocksSkipped}` : ''}${parseStats.duplicateIdsRenumbered ? ` | ID-uri duplicate normalizate: ${parseStats.duplicateIdsRenumbered}` : ''}${accountingDelta ? ` | diferență de numărătoare: ${accountingDelta}` : ''}.${c.reset}`);
    if (musicSegmentCount || musicOnlyCueCount) {
        console.log(`${c.cyan}[Versuri muzicale] Excluse înainte de Gemini: ${musicSegmentCount} segmente marcate și ${musicOnlyCueCount} blocuri compuse exclusiv din versuri; aceste texte nu au fost incluse în calupuri.${c.reset}`);
    }

    // Este posibil ca o sursă să conțină numai versuri muzicale. În acest caz
    // filtrarea timpurie produce un SRT gol valid, fără a consuma Gemini.
    if (!items.length && musicSegmentCount > 0) {
        console.log(`${c.cyan}[Versuri muzicale] Nu a rămas dialog după filtrare; Gemini nu a fost apelat.${c.reset}`);
        if (qaStatus && typeof qaStatus === 'object') {
            qaStatus.hasErrors = false;
            qaStatus.hasWarnings = false;
            qaStatus.unresolvedIds = [];
            qaStatus.warningIds = [];
        }
        return '';
    }
    if (!items.length) throw new Error('Nu s-au găsit subtitrări valide.');

    const cleanKeys = Array.from(new Set(apiKeys.map(k => String(k).trim()).filter(Boolean)));
    if (!cleanKeys.length) throw new Error('Nu există chei Gemini valide.');

    const keyStates = createKeyState(cleanKeys);
    const chunks = chunkArray(items, CHUNK_SIZE);

    const translatedById = Object.create(null);
    // Cue-urile alcătuite numai din versuri muzicale nu trebuie să consume Gemini și vor fi omise din SRT-ul final.
    for (const item of items) {
        if (item.musicOnly) translatedById[String(item.id)] = item.text;
    }
    let previousTranslatedContext = [];

    for (let batchStart = 0; batchStart < chunks.length; batchStart += CONCURRENCY_LIMIT) {
        const batch = chunks.slice(batchStart, batchStart + CONCURRENCY_LIMIT);

        const promises = batch.map(async (chunk, localIndex) => {
            const globalIndex = batchStart + localIndex;
            const start = globalIndex * CHUNK_SIZE;
            const end = start + chunk.length;

            if (localIndex > 0) await sleep(1500 * localIndex);

            // Numai primul calup continuă imediat contextul tradus al batch-ului anterior.
            // Calupurile paralele următoare folosesc contextul original din allItems,
            // fără un context românesc învechit cu 165–330 de replici.
            const contextForChunk = localIndex === 0 ? previousTranslatedContext : [];
            const result = await processChunkWithRetry(chunk, items, start, end, contextForChunk, keyStates, globalIndex, chunks.length);
            return { globalIndex, result };
        });

        const results = await Promise.all(promises);
        results.sort((a, b) => a.globalIndex - b.globalIndex);

        for (const batchResult of results) {
            // v12.78.252: dezactivate intenționat detectorul statistic și detectorul local
            // de aliniere. În testele anterioare nu au produs reparații confirmate și au
            // declanșat false positive. Nu mai generează apeluri Gemini sau alarme.
            // Maparea normală ID→replică și toate verificările independente rămân active.
            for (const item of batchResult.result) {
                translatedById[String(item.id)] = item.text;
            }
        }

        const lastResult = results[results.length - 1];
        if (lastResult && lastResult.result) {
            previousTranslatedContext = lastResult.result.slice(-PREVIOUS_TRANSLATION_CONTEXT);
        }
    }

    const deferred429Chunks = Array.isArray(keyStates._deferred429Chunks)
        ? keyStates._deferred429Chunks.splice(0)
        : [];
    if (deferred429Chunks.length) {
        const high429Queue = deferred429Chunks.length >= Math.max(1, Math.ceil(chunks.length * 0.5));
        console.log(`${c.cyan}[429 Retry] ${deferred429Chunks.length} calupuri/segmente amânate; coadă ${high429Queue ? 'mare' : 'limitată'}.${c.reset}`);

        // Dacă toate proiectele au intrat în cooldown, așteptăm până la primul
        // proiect eligibil, nu până expiră cel mai lung cooldown. O limită comună
        // identificată explicit păstrează și poarta globală; după orice așteptare,
        // verificăm din nou disponibilitatea înainte să trimitem calupul de probă.
        const waitStartedAt = Date.now();
        const poolGateWaitMs = Math.min(
            60000,
            Math.max(0, getGlobal429Until(keyStates) - waitStartedAt)
        );
        const globalWaitMs = Math.max(
            0,
            Number(geminiRequestControl.cooldownUntil || 0) - waitStartedAt,
            Number(geminiRequestControl.global429PauseUntil || 0) - waitStartedAt,
            poolGateWaitMs
        );
        const projectCooldownMs = getMinimumTransientPoolCooldownMs(keyStates, waitStartedAt, false);
        const waitMs = Math.max(globalWaitMs, Math.min(projectCooldownMs, 60000));
        if (waitMs > 0) {
            const waitReason = globalWaitMs > 0 && globalWaitMs >= Math.min(projectCooldownMs, 60000)
                ? 'pauza globală și poarta pool-ului'
                : 'până când primul proiect devine eligibil';
            console.log(`${c.yellow}[429 Retry] ${Math.ceil(waitMs / 1000)}s pauză înaintea recuperării; aștept ${waitReason}, apoi verific din nou proiectele eligibile.${c.reset}`);
            await sleep(waitMs + 250);
        }
        const availabilityAfterWait = getGeminiPoolAvailability(keyStates);
        if (!availabilityAfterWait.available.length) {
            tripPrimary429Circuit(keyStates, high429Queue
                ? 'majoritatea calupurilor au primit 429, iar după pauza de recuperare nu există proiect eligibil'
                : 'după pauza de recuperare nu există proiecte disponibile și nici o fereastră temporară utilizabilă');
        }

        if (!keyStates._primary429CircuitOpen) {
            // Începe o singură rundă de recuperare după fereastra de cooldown.
            // Resetăm marcajele 429 ale rundei inițiale, nu pauzele pe fiecare proiect.
            keyStates._429WaveFailedProjects = new Set();
            keyStates._429WaveExhaustionLogged = false;

            // După proba unică, restul cozii folosește concurența adaptivă.
            // După epuizarea temporară a pool-ului sau o limită comună, concurența
            // pornește prudent de la 1 și crește gradual numai după succese.
            let taskIndex = 0;
            let recoveryProbePending = true;
            while (taskIndex < deferred429Chunks.length) {
                const adaptiveLimit = Math.max(1, Math.min(
                    CONCURRENCY_LIMIT,
                    Number(geminiRequestControl.maxConcurrent || 1),
                    deferred429Chunks.length - taskIndex
                ));
                // Prima reluare este întotdeauna un singur calup de probă. Dacă
                // reușește, continuăm cu limita adaptivă; dacă pool-ul a fost
                // epuizat temporar, concurența crește la 2/3 numai după succese.
                const currentLimit = recoveryProbePending ? 1 : adaptiveLimit;
                const retryBatch = deferred429Chunks.slice(taskIndex, taskIndex + currentLimit);
                const failuresBeforeBatch = Number(keyStates._deferred429RetryFailedCount || 0);
                console.log(`${c.cyan}[429 Retry] Relansez ${retryBatch.length} calupuri în paralel; concurență ${currentLimit}/${geminiRequestControl.targetConcurrent}.${c.reset}`);

                const retryResults = await Promise.all(retryBatch.map(async (task, localIndex) => {
                    // Decalaj mic pentru a evita pornirea simultană în aceeași milisecundă,
                    // fără a transforma coada de recuperare într-o procesare secvențială.
                    if (localIndex > 0) await sleep(250 * localIndex);
                    const retryResult = await processChunkWithRetry(
                        task.chunk,
                        task.allItems,
                        task.chunkStart,
                        task.chunkEnd,
                        task.previousTranslatedContext,
                        keyStates,
                        task.globalChunkIndex,
                        task.totalChunks,
                        task.depth,
                        task.alignmentRepair,
                        true
                    );
                    return { task, retryResult };
                }));

                // Aplicăm rezultatele în ordinea originală; Promise.all păstrează ordinea
                // de intrare chiar dacă răspunsurile Gemini se termină în altă ordine.
                for (const entry of retryResults) {
                    const taskItemsById = new Map(entry.task.chunk.map(item => [String(item.id), item]));
                    for (const item of entry.retryResult) {
                        const id = String(item.id);
                        if (entry.task.alignmentRepair && !canRetranslateAlignmentItem(taskItemsById.get(id))) continue;
                        translatedById[id] = item.text;
                    }
                }

                const batchFailedWith429 = Number(keyStates._deferred429RetryFailedCount || 0) > failuresBeforeBatch;
                taskIndex += retryBatch.length;
                if (batchFailedWith429) {
                    if (high429Queue) {
                        tripPrimary429Circuit(keyStates, 'calupul de probă după cooldown a primit din nou 429; restul calupurilor amânate nu vor fi bombardate cu cereri');
                    } else {
                        console.log(`${c.yellow}[429 Retry] Calupul de probă a primit din nou 429; opresc restul cozii amânate pentru a păstra recuperarea limitată.${c.reset}`);
                    }
                    break;
                }
                recoveryProbePending = false;
            }
        }
    }

    const eligibleMainItems = items.filter(item => {
        if (item.musicOnly) return false;
        const source = String(item.text || '').replace(/<[^>]+>/g, '').trim();
        return Boolean(source) && !isJunkOrInterjection(item.text);
    });
    const populatedMainCount = eligibleMainItems.filter(item =>
        String(translatedById[String(item.id)] || '').replace(/<[^>]+>/g, '').trim()
    ).length;
    console.log(`${c.green}[Gemini] Calupuri procesate: ${chunks.length}/${chunks.length}; traduceri utilizabile ${populatedMainCount}/${eligibleMainItems.length}.${c.reset}`);

    let sourceGroundedCorrections = 0;
    for (const item of items) {
        if (item.musicOnly) continue;
        const id = String(item.id);
        const before = String(translatedById[id] || '');
        const after = applyBecauseOfWhatISaidCorrection(item.text, before);
        if (after !== before) {
            translatedById[id] = formatSubtitleLine(after);
            sourceGroundedCorrections++;
        }
    }
    if (sourceGroundedCorrections) {
        console.log(`${c.green}[Corecturi locale] ${sourceGroundedCorrections} corecții ancorate în originalul EN aplicate înainte de retry.${c.reset}`);
    }

    const emptyTranslations = items.filter(item => {
        if (item.musicOnly) return false;
        const id = String(item.id);
        if (getIntentionallySuppressedTranslationIds(keyStates).has(id)) return false;
        const originalClean = isEffectivelyEmptySubtitleText(item.text) ? '' : String(item.text || '').replace(/<[^>]+>/g, '').trim();
        if (!originalClean || isJunkOrInterjection(item.text) || isOnlyStandaloneFillerSequence(item.text) || isStandaloneNonDialogueSoundCue(item.text)) return false;
        const translated = translatedById[id];
        return !String(translated || '').replace(/<[^>]+>/g, '').trim();
    });

    if (emptyTranslations.length > 0) {
        console.log(`${c.cyan}[Empty Recovery] Verific ${emptyTranslations.length} traduceri care necesită recuperare locală/AI.${c.reset}`);
        const localRecovery = recoverEmptyTranslationsLocally(
            items, emptyTranslations, translatedById, 'Empty Recovery'
        );
        let recoveredCount = localRecovery.recoveredIds.length;
        const recoveredIds = [...localRecovery.recoveredIds];
        let parsedInitialResponse = false;
        let initialRecoveryApiFailure = false;
        const pendingEmptyTranslations = localRecovery.remaining;

        if (pendingEmptyTranslations.length && !keyStates._emptyRecoveryQuotaBlocked && !keyStates._primary429CircuitOpen && !keyStates._secondaryRecovery429Hold) {
            const recoveryResult = await recoverEmptyTranslationsBatched(
                pendingEmptyTranslations, translatedById, keyStates, 'Empty Recovery'
            );
            recoveredCount += recoveryResult.recoveredCount;
            recoveredIds.push(...recoveryResult.recoveredIds);
            const failedItems = recoveryResult.failedItems;
            parsedInitialResponse = recoveryResult.parsedAnyResponse;
            initialRecoveryApiFailure = recoveryResult.apiFailure;

            // Doar ID-urile încă goale după împărțirea JSON-ului primesc retry individual.
            // Dacă API-ul a răspuns cu 503/altă eroare de transport, nu lansăm rafală de cereri.
            if (parsedInitialResponse && !initialRecoveryApiFailure && !keyStates._emptyRecoveryQuotaBlocked && !keyStates._emptyRecoveryIndividualRetriesDisabled) {
                for (const item of failedItems) {
                    if (keyStates._emptyRecoveryQuotaBlocked || keyStates._emptyRecoveryIndividualRetriesDisabled) break;
                    const id = String(item.id);
                    const retryResult = await retryEmptyTranslationIndividually(
                        item, translatedById, keyStates, 'Empty Recovery'
                    );
                    if (retryResult === true) {
                        recoveredCount++;
                        recoveredIds.push(id);
                    }
                }
            }
        }

        if (pendingEmptyTranslations.length && (keyStates._primary429CircuitOpen || keyStates._secondaryRecovery429Hold) && !keyStates._emptyRecoveryAiSkipLogged) {
            keyStates._emptyRecoveryAiSkipLogged = true;
            console.log(`${c.yellow}[Empty Recovery] Recuperarea AI a fost sărită: circuitul 429 este deschis; liniile rămân pentru QA FINAL, fără cereri repetate.${c.reset}`);
        }

        // Raportăm ID-urile încă goale după toate încercările, inclusiv fallback-ul local.
        const intentionallySuppressedCount = emptyTranslations.filter(item =>
            getIntentionallySuppressedTranslationIds(keyStates).has(String(item.id))
        ).length;
        const recoveryEligibleCount = Math.max(0, emptyTranslations.length - intentionallySuppressedCount);
        const stillEmpty = emptyTranslations.filter(item =>
            !getIntentionallySuppressedTranslationIds(keyStates).has(String(item.id)) &&
            !String(translatedById[String(item.id)] || '').replace(/<[^>]+>/g, '').trim()
        );
        const recoveredSuffix = recoveredIds.length ? ` (ID: ${recoveredIds.join(', ')})` : '';
        if (stillEmpty.length === 0) {
            console.log(`${c.green}✔ [Empty Recovery] Recuperate: ${recoveredCount}/${recoveryEligibleCount}; omise intenționat: ${intentionallySuppressedCount}${recoveredSuffix}.${c.reset}`);
        } else {
            console.log(`${c.yellow}[Empty Recovery] Recuperate: ${recoveredCount}/${recoveryEligibleCount}; omise intenționat: ${intentionallySuppressedCount}; încă fără traducere: ${stillEmpty.length}.${c.reset}`);
        }
    }

    const targetedRetry = await globalPostCheck(items, translatedById, keyStates, 2);
    console.log(`${c.green}[RETRY FINAL] ${targetedRetry.fixed} replici reparate.${c.reset}`);

    // Reparăm determinist doar connectorii repetați când cele două originale
    // stabilesc fără ambiguitate că primul bloc a adăugat conectorul prea devreme.
    // Astfel, cazul de limită nu mai consumă o cerere Grammar Review/JSON.
    applyDeterministicBoundaryConnectorFixes(items, translatedById);

    // Verificare AI punctuală și limitată: numai replicile pe care semnalele
    // locale le marchează ca potențial corupte/agramaticale. Nu revizuim toate
    // subtitrările și nu schimbăm modelul, calupurile sau mecanismul cheilor.
    const localQuality = await runLocalGrammarQualityPass(items, translatedById);
    const semanticQualityItems = runSemanticSpotCheck(items, translatedById);
    const targetedReasonById = { ...localQuality.reasonsById };
    for (const item of semanticQualityItems) {
        const id = String(item.id);
        const reasons = detectSemanticSpotCheckReasons(translatedById[id] || '');
        if (reasons.length) {
            targetedReasonById[id] = [targetedReasonById[id], reasons.join('; ')].filter(Boolean).join('; ');
        }
    }

    const targetedQualityIds = new Set([
        ...localQuality.flaggedItems.map(item => String(item.id)),
        ...semanticQualityItems.map(item => String(item.id))
    ]);
    const intentionallySuppressedIds = getIntentionallySuppressedTranslationIds(keyStates);
    const targetedQualityCandidates = items.filter(item =>
        targetedQualityIds.has(String(item.id)) && !intentionallySuppressedIds.has(String(item.id))
    );
    const MAX_TARGETED_QUALITY_REVIEW_ITEMS = 50;
    let firstQualityReview = { checked: 0, fixed: 0, rejectedQualityReasonsById: Object.create(null) };
    if (targetedQualityCandidates.length && !keyStates._primary429CircuitOpen && !keyStates._secondaryRecovery429Hold) {
        const reviewItems = targetedQualityCandidates.slice(0, MAX_TARGETED_QUALITY_REVIEW_ITEMS);
        console.log(`${c.cyan}🎯 [Quality Retry] Verificare AI punctuală pentru ${reviewItems.length} replici.${c.reset}`);
        firstQualityReview = await grammarTranslationReview(reviewItems, translatedById, keyStates, {
            mode: 'targeted',
            contextItems: items,
            reasonById: targetedReasonById
        });
        console.log(`${c.green}✔ [Quality Retry] ${firstQualityReview.checked} verificate punctual, ${firstQualityReview.fixed} corectate.${c.reset}`);
    } else if (targetedQualityCandidates.length && (keyStates._primary429CircuitOpen || keyStates._secondaryRecovery429Hold)) {
        console.log(`${c.yellow}⚠ [Quality Retry] Omisă: circuitul 429 este deschis; nu pornim corecturi AI după eșecul traducerii.${c.reset}`);
    } else {
        console.log(`${c.green}✔ [Quality Retry] Nicio replică nu a declanșat verificarea AI punctuală; nu s-a adăugat o cerere Gemini.${c.reset}`);
    }

    // Verificare după corectare: reevaluăm numai replicile care încă au semnale
    // cunoscute. Un singur al doilea tur, limitat la 15 replici, evită atât acceptarea
    // oarbă a unei corecturi greșite, cât și o Grammar Review costisitoare pentru tot filmul.
    const unresolvedQualityMap = new Map();
    for (const item of items) {
        if (isJunkOrInterjection(item.text)) continue;
        const id = String(item.id);
        const text = String(translatedById[id] || '');
        if (!text.trim()) continue;
        const reasons = collectQualityReviewReasons(item, text, items, translatedById);
        if (reasons.length) unresolvedQualityMap.set(id, { item, reasons: [...new Set(reasons)] });
    }
    for (const issue of findRepeatedBoundaryConnectorIssues(items, translatedById)) {
        const id = String(issue.item.id);
        const existing = unresolvedQualityMap.get(id);
        if (existing) existing.reasons.push(issue.reason);
        else unresolvedQualityMap.set(id, { item: issue.item, reasons: [issue.reason] });
    }
    // Suprapunerile lexicale simple nu declanșează a doua rundă AI; sunt raportate
    // la final ca avertismente, pentru a evita costuri și modificări false-pozitive.
    if (unresolvedQualityMap.size && targetedQualityCandidates.length && !keyStates._primary429CircuitOpen && !keyStates._secondaryRecovery429Hold) {
        const retryCandidates = items.filter(item => unresolvedQualityMap.has(String(item.id))).slice(0, 15);
        const retryReasonById = Object.fromEntries(retryCandidates.map(item => {
            const id = String(item.id);
            const unresolvedReasons = unresolvedQualityMap.get(id).reasons;
            const rejectedReasons = firstQualityReview.rejectedQualityReasonsById?.[id] || [];
            return [id, [...new Set([
                ...unresolvedReasons,
                ...rejectedReasons.map(reason => `propunere anterioară respinsă: ${reason}`)
            ])].join('; ')];
        }));
        console.log(`${c.cyan}🔁 [Quality Recheck] Reverificare punctuală pentru ${retryCandidates.length} replici.${c.reset}`);
        const recheck = await grammarTranslationReview(retryCandidates, translatedById, keyStates, {
            mode: 'targeted',
            contextItems: items,
            reasonById: retryReasonById
        });
        console.log(`${c.cyan}🔁 [Quality Recheck] ${recheck.checked} reverificate, ${recheck.fixed} corectate la a doua verificare.${c.reset}`);
    }

    // Recuperare finală independentă de Grammar Review pentru eventuale traduceri goale.
    await recoverEmptyTranslationsFinal(items, translatedById, keyStates);

    // Ultima protecție: corecțiile mecanice certe se reaplică înainte de export.
    // formatSubtitleLine() este idempotent pentru aceste corecții și reaplică
    // dicționarul determinist la final.
    for (const item of items) {
        if (item.musicOnly) continue;
        const id = String(item.id);
        const current = translatedById[id];
        if (current == null || String(current).trim() === '') continue;

        // Protecție suplimentară: formatterul final nu are voie să șteargă
        // accidental o traducere care exista deja. Dacă după curățare toate
        // caracterele dispar, păstrăm ultima traducere nenulă disponibilă.
        const currentText = String(current);
        let finalText = applyDeterministicSemanticFix(
            item.text,
            formatSubtitleLine(currentText)
        );
        finalText = applySourceGroundedSemanticFixes(item.text, finalText);
        finalText = applyLocalGrammarDeterministicFixes(finalText);
        const formattedFinalText = formatSubtitleLine(finalText);

        if (String(formattedFinalText).trim()) {
            translatedById[id] = formattedFinalText;
        } else {
            translatedById[id] = currentText;
            console.log(`${c.yellow}⚠ [Protecție finală] ID ${id}: formatterul ar fi golit traducerea; am păstrat ultima variantă nenulă.${c.reset}`);
        }
    }

    applyContinuationCase(items, translatedById);
    // Ultima apărare contra conectorilor reintroduși de Grammar Review.
    applyDeterministicBoundaryConnectorFixes(items, translatedById);

    // Reparare finală pe baza verificărilor efectuate după formatare.
    // Astfel, semnalele care au supraviețuit verificărilor anterioare revin la
    // corectare contextuală înainte de export, nu doar în raportul final.
    const finalRepairReasonById = Object.create(null);
    const finalRepairCandidates = [];
    for (const item of items) {
        if (item.musicOnly) continue;
        const id = String(item.id);
        const originalClean = isEffectivelyEmptySubtitleText(item.text)
            ? ''
            : String(item.text || '').replace(/<[^>]+>/g, '').trim();
        if (!originalClean || isJunkOrInterjection(item.text)) continue;

        const current = String(translatedById[id] || '');
        const reasons = [];
        if (!current.trim()) reasons.push('traducere goală; trebuie completată în română');
        if (hasUntranslatedEnglish(item.text, current)) reasons.push('posibil fragment englezesc netradus; repară fragmentul în română');
        if (hasCorruptedSubtitleText(current, item.text)) reasons.push('posibil text corupt; reconstruiește formularea din original și context');
        reasons.push(...getSourceFidelityIssues(item.text, current));
        reasons.push(...collectQualityReviewReasons(item, current, items, translatedById));
        const uniqueReasons = [...new Set(reasons)];
        if (uniqueReasons.length) {
            finalRepairCandidates.push(item);
            finalRepairReasonById[id] = uniqueReasons.join('; ');
        }
    }
    for (const issue of findRepeatedBoundaryConnectorIssues(items, translatedById)) {
        const id = String(issue.item.id);
        if (!finalRepairCandidates.some(item => String(item.id) === id)) {
            finalRepairCandidates.push(issue.item);
        }
        finalRepairReasonById[id] = [finalRepairReasonById[id], issue.reason].filter(Boolean).join('; ');
    }
    for (const issue of findAdjacentSemanticOverlapIssues(items, translatedById)) {
        const id = String(issue.item.id);
        if (!finalRepairCandidates.some(item => String(item.id) === id)) {
            finalRepairCandidates.push(issue.item);
        }
        finalRepairReasonById[id] = [finalRepairReasonById[id], issue.reason].filter(Boolean).join('; ');
    }
    // Suprapunerea lexicală la limită nu declanșează reparare automată: lipsa dovezii
    // că textul a fost efectiv preluat nu justifică rescrierea cue-urilor.

    if (finalRepairCandidates.length && !keyStates._primary429CircuitOpen && !keyStates._secondaryRecovery429Hold) {
        const beforeFinalRepair = new Map(finalRepairCandidates.map(item => [
            String(item.id), String(translatedById[String(item.id)] || '')
        ]));
        console.log(`${c.cyan}[Final Repair] Corectare contextuală finală pentru ${finalRepairCandidates.length} replici candidate...${c.reset}`);
        const finalReview = await grammarTranslationReview(
            finalRepairCandidates,
            translatedById,
            keyStates,
            { mode: 'targeted', contextItems: items, reasonById: finalRepairReasonById }
        );

        // Reaplicăm numai formatarea sigură pe replicile corectate în ultimul pas.
        for (const item of finalRepairCandidates) {
            const id = String(item.id);
            const current = String(translatedById[id] || '');
            if (!current.trim() || current === beforeFinalRepair.get(id)) continue;
            let finalText = applyDeterministicSemanticFix(item.text, formatSubtitleLine(current));
            finalText = applySourceGroundedSemanticFixes(item.text, finalText);
            finalText = applyLocalGrammarDeterministicFixes(finalText);
            const formatted = formatSubtitleLine(finalText);
            if (formatted.trim()) translatedById[id] = formatted;
        }
        applyContinuationCase(items, translatedById);
        applyDeterministicBoundaryConnectorFixes(items, translatedById);
        console.log(`${c.green}[Final Repair] Verificare finală încheiată; ${Number(finalReview?.fixed || 0)} corectări aplicate.${c.reset}`);
    } else if (finalRepairCandidates.length && (keyStates._primary429CircuitOpen || keyStates._secondaryRecovery429Hold)) {
        console.log(`${c.yellow}[Final Repair] Omisă pentru ${finalRepairCandidates.length} candidate: circuitul 429 este deschis; nu înlocuim o lipsă de traducere cu cereri Grammar Review.${c.reset}`);
    }

    // Filtru final: eliminăm orice segment dintre (...) sau [...]. Cue-urile
    // sonore se clasifică pe baza sursei înainte de Gemini, nu printr-o euristică
    // aplicată orbește cuvintelor românești dintr-o traducere deja validă.
    let finalBracketedOrCueSegmentsRemoved = 0;
    const suppressedSourceSoundCueIds = new Set();
    const suppressedTranslatedNonDialogueOnlyIds = new Set();
    const finalFilterRecoveryItems = [];
    for (const item of items) {
        const id = String(item.id);
        const current = String(translatedById[id] || '');

        // Dacă sursa însăși este o descriere sonoră autonomă, o lăsăm goală definitiv.
        if (isStandaloneNonDialogueSoundCue(item.text)) {
            if (current.trim()) {
                const sourceCueOutput = stripNonDialogueSoundMarkup(current);
                if (sourceCueOutput.removedCount) finalBracketedOrCueSegmentsRemoved += sourceCueOutput.removedCount;
            }
            translatedById[id] = '';
            suppressedSourceSoundCueIds.add(id);
            continue;
        }

        if (!current.trim()) continue;
        // Pentru o replică-sursă deja clasificată drept dialog, aplicăm aici numai
        // eliminarea parantezelor. Nu rulăm lista euristică de cue-uri pe traducere:
        // un cuvânt românesc legitim (de ex. „bătut”) poate coincide cu un efect sonor.
        const soundCleaned = stripBracketedSegments(current);
        if (soundCleaned.removedCount) finalBracketedOrCueSegmentsRemoved += soundCleaned.removedCount;
        translatedById[id] = soundCleaned.text.trim();
        if (soundCleaned.removedCount && !String(soundCleaned.text || '').trim()) {
            // Sursa a trecut deja de filtrarea inițială și nu este un cue non-dialogat.
            // Dacă filtrarea finală golește traducerea (de ex. Gemini a ambalat dialogul
            // în paranteze), NU o marcăm drept omitere intenționată: încercăm recuperarea.
            if (isJunkOrInterjection(item.text) || isStandaloneNonDialogueSoundCue(item.text) ||
                getIntentionallySuppressedTranslationIds(keyStates).has(id)) {
                suppressedTranslatedNonDialogueOnlyIds.add(id);
            } else {
                finalFilterRecoveryItems.push(item);
            }
        }
    }

    if (finalFilterRecoveryItems.length) {
        const ids = finalFilterRecoveryItems.map(item => String(item.id)).join(', ');
        console.log(`${c.yellow}[Filtru paranteze/cue-uri] ${finalFilterRecoveryItems.length} traduceri de replici normale au devenit goale după filtrare (ID: ${ids}); încerc recuperarea înainte de QA.${c.reset}`);
        // Întâi încercăm o recuperare locală fără cost API, apoi doar pentru cazurile
        // nerezolvate cerem o traducere individuală, evitând re-trimiterea întregului calup.
        const localRecovery = recoverEmptyTranslationsLocally(items, finalFilterRecoveryItems, translatedById, 'Filtru final Local');
        const locallyRecovered = new Set(localRecovery.recoveredIds.map(String));
        for (const item of finalFilterRecoveryItems) {
            const id = String(item.id);
            if (locallyRecovered.has(id)) continue;
            if (String(translatedById[id] || '').trim()) continue;
            if (getIntentionallySuppressedTranslationIds(keyStates).has(id)) continue;
            if (keyStates._primary429CircuitOpen || keyStates._secondaryRecovery429Hold || keyStates._emptyRecoveryQuotaBlocked) {
                console.log(`${c.yellow}[Filtru final Recovery] ID ${id}: recuperarea AI omisă deoarece circuitul de quota/429 este în pauză; QA va raporta dacă replica rămâne goală.${c.reset}`);
                continue;
            }
            await retryEmptyTranslationIndividually(item, translatedById, keyStates, 'Filtru final Recovery');
        }
        // Reaplicăm filtrarea strictă traducerilor recuperate. Dacă și a doua variantă
        // este alcătuită numai din segmente delimitate, rămâne goală și QA o raportează;
        // nu o ascundem drept cue intenționat.
        for (const item of finalFilterRecoveryItems) {
            const id = String(item.id);
            const current = String(translatedById[id] || '');
            if (!current.trim()) continue;
            const cleaned = stripBracketedSegments(current);
            if (cleaned.removedCount) finalBracketedOrCueSegmentsRemoved += cleaned.removedCount;
            translatedById[id] = cleaned.text.trim();
            if (!cleaned.text.trim()) {
                console.log(`${c.yellow}[Filtru final Recovery] ID ${id}: traducerea a rămas goală și după reîncercare; nu este marcată ca omisă intenționat și va fi verificată de QA.${c.reset}`);
            }
        }
    }

    if (suppressedTranslatedNonDialogueOnlyIds.size) {
        const ids = [...suppressedTranslatedNonDialogueOnlyIds].join(', ');
        console.log(`${c.cyan}[Filtru paranteze/cue-uri] ${suppressedTranslatedNonDialogueOnlyIds.size} traduceri au rămas goale după eliminarea segmentelor delimitate/cue-urilor; fără recuperare AI (ID: ${ids}).${c.reset}`);
    }
    if (finalBracketedOrCueSegmentsRemoved) {
        console.log(`${c.cyan}[Filtru paranteze/cue-uri] Eliminate ${finalBracketedOrCueSegmentsRemoved} segmente delimitate sau cue-uri sonore din traducerile finale.${c.reset}`);
    }

    // Corectare locală conservatoare a majusculelor după toate reviziile AI și
    // filtrele finale, înainte ca QA și exportul SRT să citească textul rezultat.
    applyMidSentenceCapitalizationFixes(items, translatedById);

    // Interjecțiile generate ca traducere izolată sunt eliminate din ieșire și
    // scoase din numitorul QA; nu trebuie raportate ca eroare de fidelitate.
    const suppressedFillerIds = items
        .filter(item => {
            const id = String(item.id);
            const translated = String(translatedById[id] || '').trim();
            // A source-only reaction/marker must not leak into the output, even if Gemini
            // returned an empty or non-empty paraphrase for it. Also suppress reaction-only translations.
            return isJunkOrInterjection(item.text) || isOnlyStandaloneFillerSequence(translated);
        })
        .map(item => String(item.id));
    // Dacă un model de reparare a eliminat un token dintr-un cue mixt, folosim sursa
    // mascată ca fallback sigur. Versurile nu se pierd; dialogul rămas în engleză
    // rămâne vizibil pentru QA, în loc să declarăm în mod fals că totul este OK.
    let musicTokenFallbackCount = 0;
    for (const item of items) {
        if (item.musicOnly || !item.musicSegments?.length) continue;
        const id = String(item.id);
        const current = String(translatedById[id] || '');
        if (!hasAllProtectedMusicTokens(item, current)) {
            translatedById[id] = item.text;
            musicTokenFallbackCount++;
        }
    }
    if (musicTokenFallbackCount) {
        console.log(`${c.yellow}[Versuri muzicale] ${musicTokenFallbackCount} cue-uri mixte au revenit la sursa mascată deoarece un token protejat nu a supraviețuit; versurile vor fi eliminate din rezultat, iar QA poate semnala dialogul netradus.${c.reset}`);
    }

    const suppressedFillerIdSet = new Set(suppressedFillerIds);
    const suppressedFinalOutputIdSet = new Set([
        ...suppressedFillerIdSet,
        ...suppressedSourceSoundCueIds,
        ...suppressedTranslatedNonDialogueOnlyIds,
        ...getIntentionallySuppressedTranslationIds(keyStates),
        ...items.filter(item => item.musicOnly).map(item => String(item.id))
    ]);

    const finalQualityFlags = [];
    for (const item of items) {
        const id = String(item.id);
        if (item.musicOnly || isJunkOrInterjection(item.text) || suppressedFinalOutputIdSet.has(id)) continue;
        const text = String(translatedById[id] || '');
        const reasons = collectQualityReviewReasons(item, text, items, translatedById);
        if (reasons.length) finalQualityFlags.push({ item, reasons: [...new Set(reasons)] });
    }
    for (const issue of findRepeatedBoundaryConnectorIssues(items, translatedById)) {
        const id = String(issue.item.id);
        if (suppressedFinalOutputIdSet.has(id)) continue;
        const existing = finalQualityFlags.find(entry => String(entry.item.id) === id);
        if (existing) {
            if (!existing.reasons.includes(issue.reason)) existing.reasons.push(issue.reason);
        } else {
            finalQualityFlags.push({ item: issue.item, reasons: [issue.reason] });
        }
    }

    // Ultima verificare diagnostică după formatarea finală. O repetiție lexicală
    // la limita dintre două cue-uri este ambiguă și poate fi legitimă; singură,
    // nu este suficientă pentru a produce un avertisment QA FINAL. Dacă ID-ul are
    // deja un alt semnal independent de calitate, atașăm suprapunerea ca informație
    // suplimentară; altfel păstrăm doar un mesaj diagnostic, fără alarmă QA.
    const finalBoundaryOverlapIssues = findPossibleBoundaryOverlapIssues(items, translatedById);
    const independentFinalFlagIds = new Set(finalQualityFlags.map(entry => String(entry.item.id)));
    const boundaryOverlapDiagnostics = [];
    for (const issue of finalBoundaryOverlapIssues) {
        const id = String(issue.item.id);
        const pairedId = String(issue.pairedItem?.id ?? '');
        if (suppressedFinalOutputIdSet.has(id) || !pairedId || suppressedFinalOutputIdSet.has(pairedId)) continue;
        const existing = independentFinalFlagIds.has(id)
            ? finalQualityFlags.find(entry => String(entry.item.id) === id)
            : null;
        if (existing) {
            if (!existing.reasons.includes(issue.reason)) existing.reasons.push(issue.reason);
        } else if (!independentFinalFlagIds.has(pairedId)) {
            boundaryOverlapDiagnostics.push(issue);
        }
    }
    const loggedBoundaryPairs = new Set();
    for (const issue of boundaryOverlapDiagnostics) {
        const id = String(issue.item.id);
        const pairedId = String(issue.pairedItem?.id ?? '');
        const pairKey = [id, pairedId].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join(':');
        if (loggedBoundaryPairs.has(pairKey)) continue;
        loggedBoundaryPairs.add(pairKey);
        const phrase = issue.reason.match(/„([^”]+)”/)?.[1] || 'expresie repetată';
        console.log(`${c.cyan}ℹ [QA diagnostic] Posibilă suprapunere lexicală între ID ${id} și ${pairedId} („${phrase}”); fără un indiciu independent, nu este raportată ca avertisment QA FINAL.${c.reset}`);
    }
    const finalSuspicious = items.filter(item => {
        const id = String(item.id);
        if (suppressedFinalOutputIdSet.has(id)) return false;
        const originalClean = isEffectivelyEmptySubtitleText(item.text) ? '' : String(item.text || '').replace(/<[^>]+>/g, '').trim();
        if (!originalClean) return false;

        const translated = translatedById[id];
        const transClean = String(translated || '').replace(/<[^>]+>/g, '').trim();
        if (!transClean) return true;
        if (isJunkOrInterjection(item.text)) return false;

        return hasUntranslatedEnglish(item.text, translated) ||
            hasCorruptedSubtitleText(translated, item.text) ||
            hasLostExplicitSourceTerm(item.text, translated);
    });

    // Raportăm o singură dată eventualele traduceri lipsă la final, fără avertismente
    // repetate pentru fiecare calup/retry. O problemă reală rămâne vizibilă în log.
    const unresolvedFinalItems = items.filter(item => {
        const id = String(item.id);
        if (suppressedFinalOutputIdSet.has(id)) return false;
        const source = String(item.text || '').replace(/<[^>]+>/g, '').trim();
        return Boolean(source) && !String(translatedById[id] || '').replace(/<[^>]+>/g, '').trim();
    });
    // Quality Review, spot-check-urile și suprapunerile lexicale sunt semnale utile,
    // dar nu toate reprezintă erori certe. Numai traducerile relevante efectiv lipsă
    // blochează livrarea/cache-ul; suspiciunile rămân avertismente.
    const finalErrorIds = new Set(unresolvedFinalItems.map(item => String(item.id)));
    const finalReviewWarnings = new Map();
    const addFinalReviewWarning = (id, reasons) => {
        const key = String(id);
        if (suppressedFinalOutputIdSet.has(key) || finalErrorIds.has(key)) return;
        const normalizedReasons = [...new Set((Array.isArray(reasons) ? reasons : [reasons])
            .map(reason => String(reason || '').trim()).filter(Boolean))];
        if (!normalizedReasons.length) return;
        const existing = finalReviewWarnings.get(key) || [];
        finalReviewWarnings.set(key, [...new Set([...existing, ...normalizedReasons])]);
    };
    for (const flag of finalQualityFlags) {
        addFinalReviewWarning(flag.item.id, flag.reasons);
    }

    // Traducerile duplicate pe originale diferite rămân un semnal pentru verificarea
    // contextuală/Quality Retry (în runLocalGrammarQualityPass), dar identitatea textului
    // românesc nu este, singură, dovadă de eroare. Nu o raportăm din nou ca avertisment
    // QA FINAL; numai alte indicii concrete, independente, pot păstra ID-ul în avertismente.
    // Suprapunerile semantice rămân verificate separat după toate etapele de reparare.
    const finalAdjacentSemanticOverlapIssues = findAdjacentSemanticOverlapIssues(items, translatedById);
    for (const issue of finalAdjacentSemanticOverlapIssues) {
        const id = String(issue.item.id);
        const pairedId = String(issue.pairedItem?.id ?? '');
        if (!pairedId || suppressedFinalOutputIdSet.has(id) || suppressedFinalOutputIdSet.has(pairedId)) continue;
        addFinalReviewWarning(id, issue.reason);
    }

    for (const item of finalSuspicious) {
        const id = String(item.id);
        const translated = String(translatedById[id] || '');
        const reasons = [];
        if (hasUntranslatedEnglish(item.text, translated)) reasons.push('posibil text englezesc rămas');
        if (hasCorruptedSubtitleText(translated, item.text)) reasons.push('text posibil corupt');
        // Raportăm cauza reală din verificarea fidelității sursei, în loc să o
        // etichetăm automat ca „termen explicit pierdut”. Funcția-wrapper
        // hasLostExplicitSourceTerm acoperă și gramatică/inversări semantice.
        const sourceFidelityIssues = getSourceFidelityIssues(item.text, translated);
        for (const fidelityIssue of sourceFidelityIssues) {
            if (!reasons.includes(fidelityIssue)) reasons.push(fidelityIssue);
        }
        if (!reasons.length) reasons.push('traducere suspectă la verificarea finală');
        addFinalReviewWarning(id, reasons);
    }

    if (qaStatus && typeof qaStatus === 'object') {
        qaStatus.hasErrors = unresolvedFinalItems.length > 0;
        qaStatus.unresolvedIds = [...finalErrorIds];
        qaStatus.hasWarnings = finalReviewWarnings.size > 0;
        qaStatus.warningIds = [...finalReviewWarnings.keys()];
    }
    if (unresolvedFinalItems.length) {
        const ids = unresolvedFinalItems.map(item => item.id).join(', ');
        console.log(`${c.red}[QA FINAL] EROARE: ${unresolvedFinalItems.length} replici fără traducere (ID: ${ids}).${c.reset}`);
    }
    // Mesajele specifice sunt afișate numai dacă semnalul este încă prezent
    // după reparare. Perechile care au fost corectate nu mai produc avertismente.
    const logRemainingPairIssues = (issues, label, describe) => {
        const seenPairs = new Set();
        for (const issue of issues) {
            const id = String(issue.item.id);
            const pairedId = String(issue.pairedItem?.id ?? '');
            if (!pairedId || suppressedFinalOutputIdSet.has(id) || suppressedFinalOutputIdSet.has(pairedId)) continue;
            if (!finalReviewWarnings.has(id) && !finalReviewWarnings.has(pairedId)) continue;
            const pairKey = [id, pairedId].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join(':');
            if (seenPairs.has(pairKey)) continue;
            seenPairs.add(pairKey);
            console.log(`${c.yellow}⚠ [QA FINAL ${label}] ID ${id} și ${pairedId}: ${describe(issue)}; semnalul persistă după verificarea contextuală.${c.reset}`);
        }
    };
    logRemainingPairIssues(
        finalAdjacentSemanticOverlapIssues,
        'Suprapunere semantică',
        issue => `expresie repetată la limita dintre cue-uri („${issue.reason.match(/„([^”]+)”/)?.[1] || 'expresie'}”)`
    );

    if (finalReviewWarnings.size) {
        const warningSamples = [...finalReviewWarnings.entries()].slice(0, 12).map(([id, reasons]) =>
            `ID ${id}: ${reasons.slice(0, 2).join('; ').slice(0, 140)}`
        );
        const remaining = finalReviewWarnings.size - warningSamples.length;
        console.log(`${c.yellow}[QA FINAL] AVERTISMENTE: ${finalReviewWarnings.size} replici au semnale de calitate care merită revizuire; acestea nu blochează livrarea subtitrării. ${warningSamples.join(' | ')}${remaining > 0 ? ` | și încă ${remaining}` : ''}.${c.reset}`);
    }
    if (!unresolvedFinalItems.length && !finalReviewWarnings.size) {
        console.log(`${c.green}[QA FINAL] OK: toate replicile relevante au traducere și nu au fost detectate probleme de calitate rămase.${c.reset}`);
    }

    let removedMusicSegmentsFromOutput = 0;
    let omittedMusicOnlyCuesFromOutput = 0;
    const output = items
        .flatMap(item => {
            const id = String(item.id);
            // Un cue compus exclusiv din versuri nu trebuie afișat deloc.
            if (item.musicOnly) {
                omittedMusicOnlyCuesFromOutput++;
                removedMusicSegmentsFromOutput += Array.isArray(item.musicSegments) ? item.musicSegments.length : 0;
                return [];
            }
            if (suppressedFinalOutputIdSet.has(id)) return [];

            const translated = String(translatedById[id] ?? '');
            if (!translated.trim()) return [];

            // Din cue-urile mixte eliminăm numai segmentele muzicale protejate;
            // dialogul din afara lor rămâne în subtitrarea finală.
            const cleaned = removeProtectedMusicTokens(translated, item);
            removedMusicSegmentsFromOutput += cleaned.removedCount;
            if (!cleaned.text.trim()) return [];

            return [`${item.id}\n${item.start} --> ${item.end}\n${cleaned.text}\n`];
        }).join('\n');

    if (removedMusicSegmentsFromOutput || omittedMusicOnlyCuesFromOutput) {
        // Plasă de siguranță pentru un cue muzical care ar putea apărea în viitor
        // pe un traseu alternativ; fluxul normal le elimină deja în parseSrt.
        console.log(`${c.cyan}[Versuri muzicale] Plasă de siguranță la export: eliminate ${removedMusicSegmentsFromOutput} segmente și ${omittedMusicOnlyCuesFromOutput} blocuri exclusiv muzicale.${c.reset}`);
    }

    return output.trim() ? output.trim() + '\n' : '';
}

// ============================================================
// TARGET URL VALIDATION / SSRF PROTECTION
// ============================================================

function ipv4FromMappedIpv6(address) {
    // IPv4-mapped IPv6 poate apărea atât cu octeți punctați, cât și în format
    // hexadecimal comprimat (ex. ::ffff:7f00:1 pentru 127.0.0.1). Normalizăm
    // ambele forme înainte de a aplica aceleași filtre IPv4.
    let value = String(address || '').toLowerCase().replace(/%.+$/, '');
    if (net.isIP(value) !== 6) return null;

    if (value.includes('.')) {
        const lastColon = value.lastIndexOf(':');
        const dotted = value.slice(lastColon + 1);
        if (net.isIP(dotted) !== 4) return null;
        const octets = dotted.split('.').map(Number);
        const high = ((octets[0] << 8) | octets[1]).toString(16);
        const low = ((octets[2] << 8) | octets[3]).toString(16);
        value = `${value.slice(0, lastColon + 1)}${high}:${low}`;
    }

    const halves = value.split('::');
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    let groups;
    if (halves.length === 2) {
        const missing = 8 - left.length - right.length;
        if (missing < 1) return null;
        groups = [...left, ...Array(missing).fill('0'), ...right];
    } else {
        groups = left;
    }
    if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/i.test(group))) return null;

    const words = groups.map(group => Number.parseInt(group, 16));
    if (!(words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff)) return null;
    return [words[6] >> 8, words[6] & 0xff, words[7] >> 8, words[7] & 0xff].join('.');
}

function isPrivateOrReservedIp(address) {
    const family = net.isIP(address);

    if (family === 4) {
        const parts = address.split('.').map(Number);
        if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
            return true;
        }

        const value = ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3];
        const inRange = (start, end) => value >= start && value <= end;

        return (
            inRange(0x00000000, 0x00FFFFFF) || // 0.0.0.0/8
            inRange(0x0A000000, 0x0AFFFFFF) || // 10.0.0.0/8
            inRange(0x64400000, 0x647FFFFF) || // 100.64.0.0/10
            inRange(0x7F000000, 0x7FFFFFFF) || // 127.0.0.0/8
            inRange(0xA9FE0000, 0xA9FEFFFF) || // 169.254.0.0/16
            inRange(0xAC100000, 0xAC1FFFFF) || // 172.16.0.0/12
            inRange(0xC0000000, 0xC00000FF) || // 192.0.0.0/24
            inRange(0xC0000200, 0xC00002FF) || // 192.0.2.0/24
            inRange(0xC0A80000, 0xC0A8FFFF) || // 192.168.0.0/16
            inRange(0xC6120000, 0xC613FFFF) || // 198.18.0.0/15
            inRange(0xC6336400, 0xC63364FF) || // 198.51.100.0/24
            inRange(0xCB007100, 0xCB0071FF) || // 203.0.113.0/24
            inRange(0xE0000000, 0xFFFFFFFF)    // multicast/reserved
        );
    }

    if (family === 6) {
        const normalized = address.toLowerCase().replace(/%.+$/, '');
        const mappedIpv4 = ipv4FromMappedIpv6(normalized);
        if (mappedIpv4) return isPrivateOrReservedIp(mappedIpv4);

        if (
            normalized === '::' ||
            normalized === '::1' ||
            normalized.startsWith('fc') ||
            normalized.startsWith('fd') ||
            /^(fe[89ab])/.test(normalized) ||
            normalized.startsWith('ff') ||
            normalized.startsWith('2001:db8:')
        ) {
            return true;
        }

        return false;
    }

    return true;
}

async function validateTargetUrl(rawUrl) {
    let parsed;

    try {
        parsed = new URL(String(rawUrl || '').trim());
    } catch (error) {
        throw new Error('URL sursă invalid.');
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Sunt permise doar URL-uri HTTP sau HTTPS.');
    }

    if (parsed.username || parsed.password) {
        throw new Error('URL-urile cu autentificare inclusă nu sunt permise.');
    }

    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

    if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.home.arpa')) {
        throw new Error('Destinația URL nu este permisă.');
    }

    let addresses;

    if (net.isIP(hostname)) {
        addresses = [{ address: hostname, family: net.isIP(hostname) }];
    } else {
        try {
            addresses = await dns.lookup(hostname, { all: true, verbatim: true });
        } catch (error) {
            throw new Error('Nu s-a putut rezolva gazda URL-ului.');
        }
    }

    if (!addresses.length || addresses.some(entry => isPrivateOrReservedIp(entry.address))) {
        throw new Error('Destinația URL nu este permisă.');
    }

    return {
        url: parsed.toString(),
        address: addresses[0].address,
        family: addresses[0].family
    };
}

async function fetchValidatedSubtitleUrl(initialUrl) {
    let currentUrl = initialUrl;
    const maxRedirects = 5;

    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
        const validation = await validateTargetUrl(currentUrl);

        const response = await axios.get(validation.url, {
            headers: { 'User-Agent': BROWSER_USER_AGENT },
            timeout: 30000,
            // Refuse oversized remote responses before they exhaust the Render process.
            maxContentLength: 25 * 1024 * 1024,
            responseType: 'text',
            maxRedirects: 0,
            validateStatus: status => status >= 200 && status < 400,
            lookup: (hostname, options, callback) => {
                callback(null, validation.address, validation.family);
            }
        });

        if (response.status >= 300) {
            const location = response.headers.location;
            if (!location) {
                throw new Error('Redirecționare URL fără destinație validă.');
            }
            currentUrl = new URL(location, validation.url).toString();
            continue;
        }

        return response;
    }

    throw new Error('Prea multe redirecționări pentru URL-ul sursă.');
}

// Descarcă un candidat de subtitrare ca bytes, urmărind manual redirecționările
// și validând fiecare destinație pentru a păstra protecția SSRF.
async function fetchValidatedSubtitleBytes(initialUrl, subdlApiKey = '', authMode = 'header') {
    let currentUrl = initialUrl;
    const maxRedirects = 5;

    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
        const validation = await validateTargetUrl(currentUrl);
        const validatedUrl = new URL(validation.url);
        const validatedHostname = validatedUrl.hostname.toLowerCase();
        const downloadHeaders = { 'User-Agent': BROWSER_USER_AGENT_FETCH };
        let requestUrl = validation.url;

        // SubDL documents X-API-Key and ?api_key= for direct download links.
        // Query auth is applied server-side only to the exact dl.subdl.com host.
        // Credentials are not saved into the opaque Stremio reference or forwarded across hosts.
        if (validatedHostname === 'dl.subdl.com' && String(subdlApiKey || '').trim()) {
            if (authMode === 'header') {
                downloadHeaders['x-api-key'] = String(subdlApiKey).trim();
            } else if (authMode === 'query') {
                const authenticatedUrl = new URL(validation.url);
                authenticatedUrl.searchParams.set('api_key', String(subdlApiKey).trim());
                requestUrl = authenticatedUrl.toString();
            }
        }

        let response;
        try {
            response = await axios.get(requestUrl, {
                headers: downloadHeaders,
                timeout: 12000,
                maxContentLength: 25 * 1024 * 1024,
                maxBodyLength: 25 * 1024 * 1024,
                responseType: 'arraybuffer',
                maxRedirects: 0,
                validateStatus: status => status >= 200 && status < 400,
                lookup: (hostname, options, callback) => {
                    callback(null, validation.address, validation.family);
                }
            });
        } catch (error) {
            // Store only safe metadata; never log or retain the full request URL.
            error.subdlDownloadMeta = { host: validatedHostname, authMode, status: Number(error?.response?.status || 0) };
            throw error;
        }

        if (response.status >= 300) {
            const location = response.headers.location;
            if (!location) throw new Error('redirecționare fără destinație validă');
            // Resolve redirects using the validated URL, not requestUrl, so the query key is not inherited.
            currentUrl = new URL(location, validation.url).toString();
            continue;
        }

        const bytes = Buffer.from(response.data || []);
        if (!bytes.length) throw new Error('descărcarea subtitrării a returnat un fișier gol');
        return bytes;
    }

    throw new Error('prea multe redirecționări pentru subtitrarea alternativă');
}

async function fetchSubdlDirectWithFallback(url, apiKey) {
    let headerError;
    try {
        return await fetchValidatedSubtitleBytes(url, apiKey, 'header');
    } catch (error) {
        headerError = error;
        const status = Number(error?.response?.status || 0);
        if (![400, 401, 403, 404, 405].includes(status)) throw error;
    }
    try {
        return await fetchValidatedSubtitleBytes(url, apiKey, 'query');
    } catch (queryError) {
        const queryStatus = Number(queryError?.response?.status || 0);
        if (![400, 401, 403, 404, 405].includes(queryStatus)) throw queryError;
        console.log(`[SubDL] Descărcarea directă cu autentificare a fost refuzată (${queryStatus}); încerc URL-ul original fără credentiale.`);
        try {
            return await fetchValidatedSubtitleBytes(url, '', 'none');
        } catch (anonymousError) {
            // Retain the last real response status for diagnostics, never the URL or key.
            if (!anonymousError.response && headerError?.response) anonymousError.response = headerError.response;
            throw anonymousError;
        }
    }
}


function normalizeDownloadedSubtitle(bytes, sourceUrl, preferredVideoFilename = '') {
    const buffer = Buffer.from(bytes || []);
    if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50) {
        return extractSubtitleFromZip(buffer, preferredVideoFilename);
    }

    let pathExtension = '';
    try { pathExtension = new URL(sourceUrl).pathname; } catch (_) {}
    const decoded = decodeSubtitleBytes(buffer);
    try {
        return normalizeSubtitleText(decoded, pathExtension || 'subtitle.srt');
    } catch (firstError) {
        // Unele endpointuri servesc SRT fără extensie sau cu o extensie generică.
        // Reîncercăm ca SRT, fără să relaxăm verificarea structurii temporale.
        return normalizeSubtitleText(decoded, 'subtitle.srt');
    }
}

function parseOpenSubtitlesFallbackUrls(rawValue, failedUrl) {
    let parsed;
    try { parsed = JSON.parse(String(rawValue || '[]')); } catch (_) { return []; }
    if (!Array.isArray(parsed)) return [];

    const failed = String(failedUrl || '');
    const result = [];
    const seen = new Set([failed]);
    const allowedHosts = new Set([
        'dl.opensubtitles.com', 'opensubtitles.com', 'www.opensubtitles.com',
        'dl.opensubtitles.org', 'opensubtitles.org', 'www.opensubtitles.org'
    ]);
    for (const value of parsed) {
        if (typeof value !== 'string' || value.length > 2048 || !isValidSubtitleSourceUrl(value)) continue;
        let url;
        try { url = new URL(value); } catch (_) { continue; }
        // The endpoint is public; fallback URLs must actually belong to OpenSubtitles,
        // not be arbitrary public URLs that turn it into a general-purpose fetch proxy.
        if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname.toLowerCase()) ||
            (url.port && url.port !== '443') || seen.has(url.toString())) continue;
        seen.add(url.toString());
        result.push(url.toString());
        if (result.length >= 3) break;
    }
    return result;
}

// ============================================================
// DOWNLOAD/UNPACK SUBTITLE ARCHIVES FOR YIFY
// ============================================================

function allowedSubtitleSourceHost(provider, hostname) {
    const host = String(hostname || '').toLowerCase();
    const allowed = provider === 'yify'
        ? ['yts-subs.com', 'www.yts-subs.com', 'yifysubtitles.org', 'www.yifysubtitles.org']
        : [];
    return allowed.includes(host);
}

function makeSubtitleDownloadFallbacks(provider, initialUrl) {
    const result = [initialUrl];
    let parsed;
    try { parsed = new URL(initialUrl); } catch (_) { return result; }
    if (provider === 'yify') {
        const match = parsed.pathname.match(/^\/subtitle\/([^/]+\.zip)$/i);
        if (match) {
            for (const host of ['yts-subs.com', 'yifysubtitles.org']) {
                const candidate = `https://${host}/subtitle/${match[1]}`;
                if (!result.includes(candidate)) result.push(candidate);
            }
        }
    }
    return [...new Set(result)];
}

async function fetchSubtitleSourceBytes(provider, initialUrl) {
    const allowedProvider = provider === 'yify';
    if (!allowedProvider) throw new Error('Sursă de subtitrare nepermisă.');

    const starts = makeSubtitleDownloadFallbacks(provider, initialUrl);
    let lastError = null;
    for (const startUrl of starts) {
        let currentUrl = startUrl;
        try {
            for (let redirects = 0; redirects <= 5; redirects++) {
                const parsed = new URL(currentUrl);
                if (parsed.protocol !== 'https:' || !allowedSubtitleSourceHost(provider, parsed.hostname)) {
                    throw new Error('domeniu de descărcare nepermis');
                }
                const validation = await validateTargetUrl(currentUrl);
                const response = await axios.get(validation.url, {
                    timeout: 18000,
                    maxContentLength: 25 * 1024 * 1024,
                    maxBodyLength: 25 * 1024 * 1024,
                    responseType: 'arraybuffer',
                    maxRedirects: 0,
                    validateStatus: status => status >= 200 && status < 400,
                    headers: {
                        'User-Agent': BROWSER_USER_AGENT_FETCH,
                        'Accept': 'application/zip, application/octet-stream, text/plain, */*',
                        'Referer': 'https://yts-subs.com/'
                    },
                    lookup: (hostname, options, callback) => callback(null, validation.address, validation.family)
                });

                if (response.status >= 300) {
                    const location = response.headers.location;
                    if (!location) throw new Error('redirecționare fără destinație');
                    currentUrl = new URL(location, validation.url).toString();
                    continue;
                }
                return Buffer.from(response.data);
            }
            throw new Error('prea multe redirecționări');
        } catch (error) {
            lastError = error;
        }
    }
    throw new Error(`descărcarea arhivei a eșuat (${subtitleSourceError(lastError)})`);
}

function decodeSubtitleBytes(buffer) {
    let text = Buffer.from(buffer).toString('utf8');
    const replacementCount = (text.match(/\uFFFD/g) || []).length;
    if (replacementCount > 2) {
        try { text = new TextDecoder('windows-1252').decode(buffer); } catch (_) {}
    }
    return text.replace(/^\uFEFF/, '').replace(/\0/g, '');
}

function convertAssSubtitleToSrt(text) {
    const lines = String(text || '').split(/\r?\n/);
    let inEvents = false;
    let format = null;
    const cues = [];
    const toSrtTime = value => {
        const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[.](\d{1,2})$/);
        if (!match) return '';
        return `${match[1].padStart(2, '0')}:${match[2]}:${match[3]},${String(match[4]).padEnd(3, '0').slice(0, 3)}`;
    };

    for (const line of lines) {
        const trimmed = line.trim();
        if (/^\[Events\]/i.test(trimmed)) { inEvents = true; continue; }
        if (/^\[[^\]]+\]/.test(trimmed)) { inEvents = false; continue; }
        if (!inEvents) continue;
        if (/^Format\s*:/i.test(trimmed)) {
            format = trimmed.slice(trimmed.indexOf(':') + 1).split(',').map(x => x.trim().toLowerCase());
            continue;
        }
        if (!/^Dialogue\s*:/i.test(trimmed) || !format) continue;
        const fields = trimmed.slice(trimmed.indexOf(':') + 1).split(',');
        const textIndex = format.indexOf('text');
        if (textIndex < 0 || fields.length < format.length) continue;
        // ASS text is the final field; rejoin commas in dialogue text.
        const values = fields.slice(0, format.length - 1);
        values.push(fields.slice(format.length - 1).join(','));
        const start = toSrtTime(values[format.indexOf('start')]);
        const end = toSrtTime(values[format.indexOf('end')]);
        let dialogue = String(values[textIndex] || '')
            .replace(/\{[^}]*\}/g, '')
            .replace(/\\[Nn]/g, '\n')
            .replace(/<[^>]+>/g, '')
            .trim();
        if (!start || !end || !dialogue) continue;
        cues.push(`${cues.length + 1}\n${start} --> ${end}\n${dialogue}`);
    }
    return cues.join('\n\n');
}

function normalizeSubtitleText(text, filename) {
    const extension = String(filename || '').toLowerCase().match(/\.(srt|vtt|ass|ssa)$/i)?.[1] || '';
    let normalized = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    if (extension === 'ass' || extension === 'ssa') {
        normalized = convertAssSubtitleToSrt(normalized);
    } else if (extension === 'vtt' || /^\s*WEBVTT\b/i.test(normalized)) {
        normalized = normalized
            .replace(/^\s*WEBVTT[^\n]*\n+/i, '')
            .replace(/^NOTE[^\n]*(?:\n(?!\n)[^\n]*)*/gim, '')
            .replace(/(^|\s)(\d{2}):(\d{2})\.(\d{3})(?=\s*-->|\s*$)/gm, (match, prefix, minutes, seconds, millis) => `${prefix}00:${minutes}:${seconds},${millis}`)
            .replace(/(\d{2}:\d{2}:\d{2})\.(\d{3})/g, '$1,$2');
    }
    normalized = normalized.trim();
    if (!normalized || !/\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{3}/.test(normalized)) {
        throw new Error('fișierul descărcat nu conține subtitrare SRT/VTT/ASS recunoscută');
    }
    return normalized.replace(/\n{3,}/g, '\n\n') + '\n';
}

function scoreSubtitleArchiveFilename(subtitleFilename, videoFilename) {
    const normalize = value => String(value || '').toLowerCase()
        .replace(/\.[a-z0-9]{2,5}$/i, '')
        .replace(/\bh[._ -]?265\b/g, ' h265 ')
        .replace(/\bh[._ -]?264\b/g, ' h264 ')
        .replace(/[._-]+/g, ' ')
        .replace(/\bweb\s+dl\b/g, ' webdl ')
        .replace(/\bweb\s+rip\b/g, ' webrip ')
        .replace(/\b(?:hevc|h265)\b/g, ' h265 ')
        .replace(/\b(?:avc|h264)\b/g, ' h264 ')
        .replace(/\s+/g, ' ').trim();
    const video = normalize(videoFilename);
    const candidate = normalize(subtitleFilename);
    if (!video || !candidate) return 0;

    const ignored = new Set(['the', 'and', 'with', 'from', 'mkv', 'mp4', 'avi', 'subtitle', 'subs', 'english', 'eng', 'srt', 'web', 'dl', 'rip', 'x265', 'x264', 'h265', 'h264', 'hevc', 'avc', 'aac', 'ac3', 'eac3', 'ddp', 'atmos', 'hdr', 'hdr10', 'dv', 'uhd', 'proper', 'repack']);
    const tokens = [...new Set(video.split(/\s+/).filter(t => t.length > 2 && !ignored.has(t)))];
    let score = 0;
    if (tokens.length) {
        const c = new Set(candidate.split(/\s+/));
        score += tokens.filter(t => c.has(t)).length * 20;
    }
    const videoResolution = (video.match(/\b(2160p|1080p|720p|576p|480p)\b/) || [])[1] || '';
    const subResolution = (candidate.match(/\b(2160p|1080p|720p|576p|480p)\b/) || [])[1] || '';
    if (videoResolution && subResolution) score += videoResolution === subResolution ? 100 : -40;

    const sourceKind = value => /\bwebdl\b/.test(value) ? 'webdl' : (/\bwebrip\b/.test(value) ? 'webrip' : (/\bbluray\b/.test(value) ? 'bluray' : ''));
    const videoKind = sourceKind(video);
    const subKind = sourceKind(candidate);
    if (videoKind && subKind) score += videoKind === subKind ? 80 : -35;

    const codec = value => /\b(?:x265|h265)\b/.test(value) ? 'h265' : (/\b(?:x264|h264)\b/.test(value) ? 'h264' : '');
    const videoCodec = codec(video);
    const subCodec = codec(candidate);
    if (videoCodec && subCodec) score += videoCodec === subCodec ? 60 : -25;

    const videoTokens = video.split(/\s+/).filter(Boolean);
    const subtitleTokens = candidate.split(/\s+/).filter(Boolean);
    const lastVideoToken = videoTokens[videoTokens.length - 1] || '';
    const lastSubtitleToken = subtitleTokens[subtitleTokens.length - 1] || '';
    if (lastVideoToken.length >= 3 && !ignored.has(lastVideoToken) && lastSubtitleToken.length >= 3) {
        if (lastSubtitleToken === lastVideoToken) score += 140;
        else if (/^[a-z][a-z0-9]{2,}$/i.test(lastVideoToken) && /^[a-z][a-z0-9]{2,}$/i.test(lastSubtitleToken)) score -= 25;
    }
    return score;
}

function extractSubtitleFromZip(buffer, preferredVideoFilename = '') {
    const bytes = Buffer.from(buffer);
    if (bytes.length < 22) throw new Error('arhivă ZIP prea scurtă');
    const minEocd = Math.max(0, bytes.length - 22 - 0xFFFF);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= minEocd; i--) {
        if (bytes.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('arhiva ZIP nu are director central valid');

    const entryCount = bytes.readUInt16LE(eocd + 10);
    const centralOffset = bytes.readUInt32LE(eocd + 16);
    if (!entryCount || entryCount > 300 || centralOffset >= bytes.length) throw new Error('arhivă ZIP goală sau cu structură neacceptată');

    const files = [];
    const MAX_TOTAL_UNCOMPRESSED_SUBTITLE_BYTES = 32 * 1024 * 1024;
    let totalUncompressedSubtitleBytes = 0;
    let offset = centralOffset;
    for (let i = 0; i < entryCount && offset + 46 <= bytes.length; i++) {
        if (bytes.readUInt32LE(offset) !== 0x02014b50) break;
        const flags = bytes.readUInt16LE(offset + 8);
        const method = bytes.readUInt16LE(offset + 10);
        const compressedSize = bytes.readUInt32LE(offset + 20);
        const uncompressedSize = bytes.readUInt32LE(offset + 24);
        const nameLength = bytes.readUInt16LE(offset + 28);
        const extraLength = bytes.readUInt16LE(offset + 30);
        const commentLength = bytes.readUInt16LE(offset + 32);
        const localOffset = bytes.readUInt32LE(offset + 42);
        const filename = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
        offset += 46 + nameLength + extraLength + commentLength;

        if ((flags & 1) !== 0 || /(^|\/)__MACOSX\//i.test(filename) || /(^|\/)\._/.test(filename) || /\/$/.test(filename)) continue;
        if (!/\.(srt|vtt|ass|ssa)$/i.test(filename)) continue;
        if (compressedSize > bytes.length || uncompressedSize > 16 * 1024 * 1024 || localOffset + 30 > bytes.length) continue;
        if (bytes.readUInt32LE(localOffset) !== 0x04034b50) continue;
        const localNameLength = bytes.readUInt16LE(localOffset + 26);
        const localExtraLength = bytes.readUInt16LE(localOffset + 28);
        const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
        const dataEnd = dataOffset + compressedSize;
        if (dataOffset < 0 || dataEnd > bytes.length) continue;
        try {
            const compressed = bytes.subarray(dataOffset, dataEnd);
            let content;
            if (method === 0) content = Buffer.from(compressed);
            else if (method === 8) content = zlib.inflateRawSync(compressed, { maxOutputLength: 16 * 1024 * 1024 });
            else continue;
            if (content.length > 16 * 1024 * 1024) continue;
            // Bound aggregate decompression too: a small ZIP can contain hundreds of
            // individually permitted files and otherwise amplify memory use.
            if (content.length > MAX_TOTAL_UNCOMPRESSED_SUBTITLE_BYTES - totalUncompressedSubtitleBytes) continue;
            totalUncompressedSubtitleBytes += content.length;
            files.push({
                filename,
                content,
                priority: /\.srt$/i.test(filename) ? 0 : (/\.vtt$/i.test(filename) ? 1 : 2),
                matchScore: scoreSubtitleArchiveFilename(filename, preferredVideoFilename)
            });
        } catch (_) {}
    }

    files.sort((a, b) => (b.matchScore - a.matchScore) || (a.priority - b.priority));
    for (const file of files) {
        try { return normalizeSubtitleText(decodeSubtitleBytes(file.content), file.filename); } catch (_) {}
    }
    throw new Error('arhiva nu conține un fișier SRT/VTT/ASS valid');
}

async function serveSubtitleSource(req, res) {
    const provider = String(req.query.provider || '').trim().toLowerCase();
    const sourceUrl = String(req.query.url || '').trim();
    const preferredVideoFilename = String(req.query.filename || '').slice(0, 512);
    if (provider !== 'yify' || !sourceUrl || sourceUrl.length > 2048) {
        return res.status(400).send('Parametri de sursă invalidi.');
    }

    let primaryError = null;
    try {
        const bytes = await fetchSubtitleSourceBytes(provider, sourceUrl);
        const subtitleText = normalizeDownloadedSubtitle(bytes, sourceUrl, preferredVideoFilename);
        res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
        res.setHeader('Cache-Control', 'private, max-age=60');
        return res.send(subtitleText);
    } catch (error) {
        primaryError = error;
    }

    // Un URL YIFY poate fi listat corect, dar arhiva să răspundă 403 din Render.
    // În acest caz încercăm până la 3 URL-uri OpenSubtitles deja clasate pentru același
    // fișier video. Astfel, un candidat YIFY inaccesibil nu blochează o sursă alternativă.
    const fallbacks = parseOpenSubtitlesFallbackUrls(req.query.fallbackUrls, sourceUrl);
    let fallbackError = null;
    for (let index = 0; index < fallbacks.length; index++) {
        const fallbackUrl = fallbacks[index];
        try {
            const bytes = await fetchValidatedSubtitleBytes(fallbackUrl);
            const subtitleText = normalizeDownloadedSubtitle(bytes, fallbackUrl, preferredVideoFilename);
            console.log(`${c.yellow}[Subtitrări] YIFY indisponibil (${subtitleSourceError(primaryError)}); folosesc fallback OpenSubtitles ${index + 1}/${fallbacks.length}.${c.reset}`);
            res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
            res.setHeader('Cache-Control', 'private, max-age=60');
            return res.send(subtitleText);
        } catch (error) {
            fallbackError = error;
            console.log(`${c.yellow}[Subtitrări] fallback OpenSubtitles ${index + 1}/${fallbacks.length} eșuat: ${subtitleSourceError(error)}${c.reset}`);
        }
    }

    const fallbackSuffix = fallbacks.length
        ? `; fallback OpenSubtitles eșuat${fallbackError ? ` (${subtitleSourceError(fallbackError)})` : ''}`
        : '; nu există URL-uri OpenSubtitles alternative eligibile';
    console.log(`${c.yellow}[Subtitrări] proxy YIFY eșuat: ${subtitleSourceError(primaryError)}${fallbackSuffix}${c.reset}`);
    return res.status(502).send('Nu s-a putut prelua subtitrarea YIFY și nu a fost disponibil un fallback OpenSubtitles utilizabil.');
}

app.get('/source-subtitle', serveSubtitleSource);

// ============================================================
// TRANSLATION ROUTE
// ============================================================

app.get('/:configData/translate', async (req, res) => {
    const imdbId = req.query.id;
    const targetUrl = req.query.targetUrl || req.query.url;
    const configData = req.params.configData;
    const subdlRef = String(req.query.subdlRef || '');
    const isInternalSubdl = subdlRef.length > 0;
    const subdlFilename = String(req.query.filename || '').slice(0, 500);

    if (isInternalSubdl && (targetUrl || req.query.source !== 'SubDL')) {
        return res.status(400).send('Parametri SubDL interni invalizi.');
    }
    if (!targetUrl && !isInternalSubdl) {
        console.log(`${c.red}✖ EROARE: Lipsă URL sursă.${c.reset}`);
        return res.status(400).send('Lipsă URL sursă.');
    }
    if (isInternalSubdl && !/^(?:api_[A-Za-z0-9_-]{16,4096}|url_[A-Za-z0-9_-]{8,2048}|[A-Za-z0-9_-]{1,128})$/.test(subdlRef)) {
        return res.status(400).send('Referință SubDL invalidă.');
    }

    const decodedConfig = decodeAddonConfigSegment(configData);
    if (!decodedConfig) {
        console.log(`${c.red}✖ EROARE: Configurare invalidă.${c.reset}`);
        return res.status(400).send('Configurare invalidă. Instalează addon-ul din nou.');
    }
    const userKeys = decodedConfig.geminiKeys;
    if (!userKeys.length) {
        console.log(`${c.red}✖ EROARE: Nu s-au putut extrage chei API valide.${c.reset}`);
        return res.status(400).send('Nu există chei Gemini configurate.');
    }
    if (isInternalSubdl && !decodedConfig.subdlKey) {
        return res.status(400).send('SubDL nu este configurat pentru această instalare.');
    }

    let validatedTarget = null;
    let cacheKey;
    if (isInternalSubdl) {
        // Opaque SubDL references never become URLs. Downloads are performed in-process
        // by getSubdlSubtitleText(), while every external download still uses SSRF checks.
        cacheKey = `subdl-ref:${configData}:${subdlRef}:${subdlFilename}`;
    } else {
        try {
            validatedTarget = await validateTargetUrl(targetUrl);
        } catch (error) {
            console.log(`${c.red}✖ EROARE: URL sursă respins: ${error.message}${c.reset}`);
            return res.status(400).send(error.message);
        }
        cacheKey = validatedTarget.url;
    }

    const cachedEntry = getMemoryCacheEntry(cacheKey);
    if (typeof cachedEntry === 'string') {
        res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
        return res.send(cachedEntry);
    }

    res.writeHead(200, {
        'Content-Type': 'application/x-subrip; charset=utf-8',
        'Transfer-Encoding': 'chunked'
    });
    res.flushHeaders();

    const keepAlive = setInterval(() => {
        if (!res.writableEnded && !res.destroyed) res.write(' \n');
    }, 8000);
    const stopKeepAlive = () => clearInterval(keepAlive);
    res.on('close', stopKeepAlive);
    res.on('finish', stopKeepAlive);

    try {
        let processPromise;
        // QA status belongs to the shared translation promise, not only to the
        // request that created it. This keeps concurrent requests in the same scope.
        let qaStatus = { hasErrors: false, hasWarnings: false, unresolvedIds: [], warningIds: [] };

        if (cachedEntry && typeof cachedEntry !== 'string') {
            processPromise = cachedEntry;
            qaStatus = processPromise.qaStatus || qaStatus;
        } else {
            const startTime = Date.now();
            
            processPromise = (async () => {
                const [srtRes, mediaTitle] = await Promise.all([
                    isInternalSubdl
                        ? getSubdlSubtitleText(configData, subdlRef, subdlFilename).then(data => ({ data }))
                        : fetchValidatedSubtitleUrl(validatedTarget.url),
                    fetchMediaTitle(imdbId)
                ]);
                rememberOriginalSource(cacheKey, String(srtRes.data || ''));

                logTranslationStart(imdbId, mediaTitle, {
                    subtitleName: req.query.subtitleName,
                    subtitleSource: req.query.source,
                    versionTag: req.query.v
                });

                return await translateSrtWithGemini(String(srtRes.data || ''), userKeys, qaStatus, getMediaContextText(imdbId));
            })();
            // Attach the shared QA state before publishing the promise to the cache.
            processPromise.qaStatus = qaStatus;
            
            memoryCache.set(cacheKey, processPromise);
            cleanMemoryCache(cacheKey);
            
            processPromise.then(translatedSrtString => {
                // Înlocuiește numai intrarea pentru această promisiune; nu suprascrie
                // accidental o intrare mai nouă dacă logica cache-ului se schimbă ulterior.
                if (memoryCache.get(cacheKey) === processPromise) {
                    memoryCache.delete(cacheKey);
                    if (!qaStatus.hasErrors && String(translatedSrtString || '').trim()) {
                        memoryCache.set(cacheKey, translatedSrtString);
                    } else {
                        console.log(`${c.yellow}[Cache] Rezultatul nu este memorat: traducerea este goală sau QA FINAL a raportat erori. O cerere ulterioară va putea reîncerca.${c.reset}`);
                    }
                }
                cleanMemoryCache(cacheKey); 
                
                const durationSeconds = Math.floor((Date.now() - startTime) / 1000);
                const timeFormatted = durationSeconds < 60 ? `${durationSeconds} sec` : `${Math.floor(durationSeconds / 60)} min și ${durationSeconds % 60} sec`;
                
                const doneLabel = qaStatus.hasErrors ? 'DONE CU ERORI QA' : qaStatus.hasWarnings ? 'DONE CU AVERTISMENTE QA' : 'DONE';
                const doneColor = qaStatus.hasErrors ? '31' : qaStatus.hasWarnings ? '33' : '96';
                console.log(`\x1b[${doneColor}m[${doneLabel}] ${imdbId} | 🕒 ${timeFormatted}\x1b[0m\n`);
                
            }).catch((err) => {
                console.log(`${c.red}✖ EROARE PROCESARE PENTRU: ${imdbId} - ${err.message}${c.reset}`);
                if (memoryCache.get(cacheKey) === processPromise) {
                    memoryCache.delete(cacheKey);
                }
            });
        }

        const finalSrt = await processPromise;
        
        if (finalSrt && finalSrt.trim().length > 0 && !qaStatus.hasErrors) {
            const now = new Date();
            const timeStr = now.toLocaleTimeString('ro-RO') + ' ' + now.toLocaleDateString('ro-RO');
            
            const existingIndex = secretArchive.findIndex(item => item.id === imdbId);
            const previousOriginal = existingIndex !== -1 ? secretArchive[existingIndex].original : '';
            if (existingIndex !== -1) {
                secretArchive.splice(existingIndex, 1);
            }

            secretArchive.unshift({ id: imdbId, time: timeStr, content: finalSrt, original: originalSources[cacheKey] || previousOriginal || '' });
            if (secretArchive.length > 10) secretArchive.pop();
        }

        clearInterval(keepAlive);
        res.write(finalSrt);
        res.end();

    } catch (error) {
        clearInterval(keepAlive);
        console.error('Translation error:', error.message);
        if (!res.headersSent) {
            res.status(500).send('Translation failed: ' + error.message);
        } else {
            res.end();
        }
    }
});

// ============================================================
// FILTRARE TIMPURIE PENTRU VERSURILE MUZICALE MARCATE EXPLICIT
// Segmentele dintre perechi ♪...♪ / ♫...♫ / ♬...♬ / ♩...♩ sunt mascate numai
// temporar pentru ca filtrele intermediare să nu le corupă, apoi eliminate în parseSrt
// înainte de formarea calupurilor. Cue-urile numai muzicale nu intră deloc în lista items.
// ============================================================
// Stil „o notă pe fiecare rând”: „♪ vers 1\n♪ vers 2” (sau nota doar la final de rând).
// Fără acest pas, perechile de note s-ar potrivi greșit între rânduri și un vers ar rămâne tradus.
function maskPerLineMusicNotes(text, cueSequence, segments) {
    const lines = String(text || '').split('\n');
    const noteLineIdx = [];
    lines.forEach((line, idx) => { if (/[♪♫♬♩]/u.test(line)) noteLineIdx.push(idx); });
    if (noteLineIdx.length < 2) return String(text || '');

    const plain = line => line
        .replace(/<[^>]*>/g, '')
        .replace(/&(?:nbsp|amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/giu, ' ')
        .trim();
    const noteCount = line => (plain(line).match(/[♪♫♬♩]/gu) || []).length;
    const startStyle = line => noteCount(line) === 1 && /^[-–—\s]*[♪♫♬♩]/u.test(plain(line));
    const endStyle = line => noteCount(line) === 1 && /[♪♫♬♩]\s*$/u.test(plain(line));
    const allStart = noteLineIdx.every(i => startStyle(lines[i]));
    const allEnd = noteLineIdx.every(i => endStyle(lines[i]));
    if (!allStart && !allEnd) return String(text || '');

    return lines.map((line, idx) => {
        if (!noteLineIdx.includes(idx)) return line;
        if (!/[\p{L}\p{N}]/u.test(plain(line).replace(/[♪♫♬♩]/gu, ' '))) return line;
        const token = `ZXQKEEPSONG${cueSequence}PART${segments.length}QXZ`;
        segments.push({ token, original: line });
        return token;
    }).join('\n');
}

function protectMusicalLyricSegments(text, cueSequence) {
    const segments = [];
    // Emoji-urile 🎵/🎶 sunt folosite uneori în loc de ♪.
    const sourceText = maskPerLineMusicNotes(String(text || '').replace(/[🎵🎶]/gu, '♪'), cueSequence, segments);
    let maskedText = sourceText.replace(/([♪♫♬♩])([\s\S]*?)\1/gu, (whole, _marker, inner) => {
        const visibleInner = String(inner || '')
            .replace(/<[^>]*>/g, ' ')
            .replace(/&(?:nbsp|amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/giu, ' ')
            .trim();
        // Nu mascăm perechi goale de note sau separatori fără conținut cântat.
        if (!/[\p{L}\p{N}]/u.test(visibleInner)) return whole;

        const token = `ZXQKEEPSONG${cueSequence}PART${segments.length}QXZ`;
        segments.push({ token, original: whole });
        return token;
    });

    // Unele subtitrări marchează versul doar cu nota de început (de ex. „♪ <i>vers...</i>”)
    // și omit nota de închidere. Fără această plasă de siguranță, markerul este șters ulterior
    // de normalizare, iar versul ajunge la Gemini ca dialog și poate rămâne tradus în rezultat.
    // Păstrăm orice text de dialog aflat înaintea notei și mascăm doar coada neînchisă.
    const unpairedTailMatch = maskedText.match(/([♪♫♬♩])([\s\S]*)$/u);
    if (unpairedTailMatch) {
        const tailStart = unpairedTailMatch.index;
        const tail = unpairedTailMatch[0];
        const protectedTokenRe = /ZXQKEEPSONG\d+PART\d+QXZ/giu;
        const visibleTail = tail
            .replace(protectedTokenRe, ' ')
            .replace(/<[^>]*>/g, ' ')
            .replace(/&(?:nbsp|amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/giu, ' ')
            .trim();

        if (/[\p{L}\p{N}]/u.test(visibleTail)) {
            // Dacă în coadă există deja un token de vers protejat, îl păstrăm separat:
            // astfel, notele incomplete nu invalidează tokenurile create pentru perechi valide.
            const tailParts = tail.split(/(ZXQKEEPSONG\d+PART\d+QXZ)/giu);
            const protectedTail = tailParts.map(part => {
                if (/^ZXQKEEPSONG\d+PART\d+QXZ$/iu.test(part)) return part;

                const visiblePart = part
                    .replace(/<[^>]*>/g, ' ')
                    .replace(/&(?:nbsp|amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/giu, ' ')
                    .trim();
                if (!/[\p{L}\p{N}]/u.test(visiblePart)) return part;

                const token = `ZXQKEEPSONG${cueSequence}PART${segments.length}QXZ`;
                segments.push({ token, original: part });
                return token;
            }).join('');

            maskedText = maskedText.slice(0, tailStart) + protectedTail;
        } else if (tail.length) {
            // Nota de închidere singură la sfârșitul replicii („vers ♪”): mascăm versul din fața ei,
            // pe același rând, fără să atingem eventualele tokenuri deja create.
            const lineStart = maskedText.lastIndexOf('\n', tailStart - 1) + 1;
            const lineHead = maskedText.slice(lineStart, tailStart);
            const tokenMatches = [...lineHead.matchAll(/ZXQKEEPSONG\d+PART\d+QXZ/giu)];
            const lastToken = tokenMatches[tokenMatches.length - 1];
            const headStart = lastToken ? lineStart + lastToken.index + lastToken[0].length : lineStart;
            const head = maskedText.slice(headStart, tailStart);
            const visibleHead = head
                .replace(/<[^>]*>/g, ' ')
                .replace(/&(?:nbsp|amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/giu, ' ')
                .trim();
            if (/[\p{L}\p{N}]/u.test(visibleHead)) {
                const token = `ZXQKEEPSONG${cueSequence}PART${segments.length}QXZ`;
                segments.push({ token, original: head + tail });
                maskedText = maskedText.slice(0, headStart) + token;
            }
        }
    }

    return { text: maskedText, segments };
}
function isMusicOnlyMaskedCue(text, musicSegments) {
    if (!Array.isArray(musicSegments) || musicSegments.length === 0) return false;
    let visible = String(text || '');
    for (const segment of musicSegments) {
        visible = visible.split(segment.token).join(' ');
    }
    visible = visible
        .replace(/<[^>]*>/g, ' ')
        .replace(/&(?:nbsp|amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/giu, ' ')
        .trim();
    // Rămân doar eventuale marcatoare de vorbitor, slash-uri, spații și punctuație.
    return !/[\p{L}\p{N}]/u.test(visible);
}

function hasAllProtectedMusicTokens(item, text) {
    const segments = Array.isArray(item?.musicSegments) ? item.musicSegments : [];
    if (!segments.length) return true;
    const value = String(text || '');
    return segments.every(segment => value.toLocaleUpperCase('en-US').includes(segment.token.toLocaleUpperCase('en-US')));
}

function removeProtectedMusicTokens(text, item) {
    let output = String(text || '');
    const segments = Array.isArray(item?.musicSegments) ? item.musicSegments : [];
    let removedCount = 0;

    for (const segment of segments) {
        // Eliminăm exclusiv tokenul protejat; textul original al versului nu este restaurat.
        const escaped = segment.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        output = output.replace(new RegExp(escaped, 'giu'), () => {
            removedCount++;
            return ' ';
        });
    }

    if (!removedCount) {
        return { text: String(text || '').trim(), removedCount: 0 };
    }

    // Eliminăm wrapper-ele HTML rămase goale (de ex. <i>TOKEN</i> după ștergere).
    for (let i = 0; i < 3; i++) {
        output = output.replace(/<([a-z][\w:-]*)\b[^>]*>\s*<\/\1>/giu, ' ');
    }

    // Îndepărtăm separatorii/dash-urile vocilor muzicale care au rămas orfani.
    // Dialogul rămas și propriul său dash de vorbitor sunt păstrate.
    output = output.replace(/^\s*(?:[-–—]\s*)?(?:\/\s*)+/u, ' ');
    output = output.replace(/\s*(?:\/\s*)+(?:[-–—]\s*)?$/u, ' ');
    output = output.replace(/\s*\/\s*(?:[-–—]\s*)?\/\s*/gu, ' / ');
    output = output.replace(/^\s*(?:[-–—]\s*)?(?:\/\s*)+/u, ' ');
    output = output.replace(/\s*(?:\/\s*)+(?:[-–—]\s*)?$/u, ' ');

    output = output
        .replace(/&(?:nbsp);/giu, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .trim();

    return { text: output, removedCount };
}

// ============================================================
// SRT PARSER NATIV 
// ============================================================

// Detectează versurile din interiorul unui cântec care se întinde pe mai multe replici:
// prima replică are nota de deschidere, ultima are nota de închidere, iar cele din mijloc
// nu au nicio notă. Condiții de siguranță: cel mult 14 replici, pauză de cel mult 3 secunde
// între replici consecutive și nicio altă notă în interior. Returnează indicii blocurilor.
function findOpenSongInteriorBlocks(blocks) {
    const toMs = value => {
        const m = String(value).match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
        return m ? ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]) : NaN;
    };
    const cues = blocks.map(block => {
        const lines = String(block).split('\n').map(l => l.trimEnd());
        if (lines.length < 3) return null;
        const timing = lines[1].trim().match(/^(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/);
        if (!timing) return null;
        const text = lines.slice(2).join('\n')
            .replace(/<[^>]*>/g, '')
            .replace(/&(?:nbsp|amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/giu, ' ');
        const noteLines = text.split('\n').filter(l => /[♪♫♬♩🎵🎶]/u.test(l));
        let kind = 'none';
        if (noteLines.length) {
            const onePerLine = noteLines.every(l => (l.match(/[♪♫♬♩🎵🎶]/gu) || []).length === 1);
            const startStyle = noteLines.every(l => /^[-–—\s]*[♪♫♬♩🎵🎶]/u.test(l));
            const endStyle = noteLines.every(l => /[♪♫♬♩🎵🎶]\s*$/u.test(l));
            const hasLetters = /\p{L}/u.test(text.replace(/[♪♫♬♩🎵🎶]/gu, ' '));
            if (!onePerLine || !hasLetters) kind = 'other';
            else if (startStyle && !endStyle) kind = 'open';
            else if (endStyle && !startStyle) kind = 'close';
            else kind = 'other';
        }
        return { start: toMs(timing[1]), end: toMs(timing[2]), kind };
    });

    const interior = new Set();
    for (let i = 0; i < cues.length; i++) {
        if (!cues[i] || cues[i].kind !== 'open') continue;
        const span = [];
        for (let j = i + 1; j < cues.length && j <= i + 14; j++) {
            const cue = cues[j];
            const previous = cues[j - 1];
            if (!cue || !previous || !(cue.start - previous.end <= 3000)) break;
            if (cue.kind === 'close') {
                span.forEach(index => interior.add(index));
                i = j;
                break;
            }
            if (cue.kind !== 'none') break;
            span.push(j);
        }
    }
    return interior;
}

function parseSrt(srt, stats = null) {
    const normalized = String(srt || '').replace(/\r/g, '').replace(/^\uFEFF/, '');
    const blocks = normalized.split(/\n[ \t]*\n(?:[ \t]*\n)*/);
    const songInteriorBlocks = findOpenSongInteriorBlocks(blocks);
    const result = [];
    let musicTokenCueSequence = 0;
    if (stats) {
        stats.fillerBlocksFiltered = 0;
        stats.otherBlocksFiltered = 0;
        stats.invalidBlocksSkipped = 0;
        stats.nonDialogueBlocksFiltered = 0;
        stats.nonDialogueSegmentsRemoved = 0;
        stats.musicSegmentsDetected = 0;
        stats.musicSegmentsRemovedBeforeTranslation = 0;
        stats.musicOnlyBlocksRemovedBeforeTranslation = 0;
        stats.duplicateIdsRenumbered = 0;
    }

    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
        const block = blocks[blockIndex];
        const lines = block.split('\n').map(l => l.trimEnd());
        if (lines.length < 3) {
            if (stats && /-->/.test(block)) stats.invalidBlocksSkipped++;
            continue;
        }

        const id = Number(lines[0].trim());
        if (!Number.isInteger(id)) {
            if (stats && /-->/.test(block)) stats.invalidBlocksSkipped++;
            continue;
        }

        const timing = lines[1].trim();
        const match = timing.match(/^(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})(?:.*)?$/);
        if (!match) {
            if (stats && /-->/.test(block)) stats.invalidBlocksSkipped++;
            continue;
        }

        let rawText = lines.slice(2).join('\n');

        // Verificăm textul ORIGINAL înainte de curățare. Unele surse folosesc
        // entități HTML pentru spații/caractere invizibile, iar acestea pot părea nenule.
        if (isEffectivelyEmptySubtitleText(rawText)) {
            if (stats) stats.otherBlocksFiltered++;
            continue;
        }

        // Mascăm mai întâi versurile explicit încadrate de note muzicale, pentru ca
        // filtrele de paranteze/interjecții și curățarea markerelor ♪ să nu le altereze.
        // Replică aflată în interiorul unui cântec deschis cu „♪” și închis mai târziu cu „♪”:
        // o încadrăm în note ca să urmeze exact același traseu ca versurile normale.
        if (songInteriorBlocks.has(blockIndex)) rawText = `♪ ${rawText} ♪`;

        const protectedMusic = protectMusicalLyricSegments(rawText, ++musicTokenCueSequence);
        if (stats && protectedMusic.segments.length) {
            stats.musicSegmentsDetected += protectedMusic.segments.length;
        }
        rawText = protectedMusic.text;

        // Eliminăm orice segment dintre paranteze rotunde sau drepte. Dacă rămâne text
        // în afara lor, îl păstrăm; segmentele muzicale mascate nu sunt afectate.
        const soundStripped = stripNonDialogueSoundMarkup(rawText);
        rawText = soundStripped.text;
        if (stats && soundStripped.removedCount) {
            stats.nonDialogueSegmentsRemoved += soundStripped.removedCount;
        }
        if (!rawText.trim() && soundStripped.removedCount) {
            if (stats) stats.nonDialogueBlocksFiltered++;
            continue;
        }
        if (isEffectivelyEmptySubtitleText(rawText)) {
            if (stats) stats.otherBlocksFiltered++;
            continue;
        }

        const sourceIsFillerOnly = isOnlyStandaloneFillerSequence(rawText);
        let text = cleanTextForJson(rawText);

        if (!text || text === ' ' || isEffectivelyEmptySubtitleText(text)) {
            if (stats) {
                if (sourceIsFillerOnly) stats.fillerBlocksFiltered++;
                else stats.otherBlocksFiltered++;
            }
            continue;
        }

        // Eliminarea muzicii are loc ACUM, înainte de formarea calupurilor și
        // înainte de orice cerere Gemini. Detectăm cue-urile compuse exclusiv
        // din versuri în forma mascată, apoi scoatem tokenurile din cue-urile mixte.
        // Astfel nici versurile, nici tokenurile lor de protecție nu ajung în prompt.
        const musicOnlyBeforeTranslation = isMusicOnlyMaskedCue(text, protectedMusic.segments);
        if (protectedMusic.segments.length) {
            if (stats) stats.musicSegmentsRemovedBeforeTranslation += protectedMusic.segments.length;

            if (musicOnlyBeforeTranslation) {
                if (stats) stats.musicOnlyBlocksRemovedBeforeTranslation++;
                continue;
            }

            const lyricsRemoved = removeProtectedMusicTokens(text, { musicSegments: protectedMusic.segments });
            text = cleanTextForJson(lyricsRemoved.text);

            // Dacă un bloc mixt conținea numai versuri plus marcatori/separatori
            // de vorbitor, nu păstrăm un cue gol de forma „- / -”.
            if (!text || text === ' ' || isEffectivelyEmptySubtitleText(text) || !/[\p{L}\p{N}]/u.test(text.replace(/<[^>]*>/g, ' '))) {
                if (stats) stats.musicOnlyBlocksRemovedBeforeTranslation++;
                continue;
            }
        }

        // Ultima verificare pe textul SURSEI după toate normalizările.
        // Doar textul de dialog rămas poate ajunge la Gemini, Empty Recovery,
        // Grammar Review sau QA; segmentele muzicale au fost deja eliminate.
        const normalizedSoundOnly = isStandaloneNonDialogueSoundCue(text);
        const normalizedFillerOnly = isOnlyStandaloneFillerSequence(text);
        if (normalizedSoundOnly || normalizedFillerOnly) {
            if (stats) {
                if (normalizedSoundOnly) stats.nonDialogueBlocksFiltered++;
                else if (normalizedFillerOnly) stats.fillerBlocksFiltered++;
            }
            continue;
        }

        result.push({
            id,
            start: match[1],
            end: match[2],
            text,
            musicSegments: [],
            musicOnly: false
        });
    }

    // ID-urile SRT sunt folosite drept chei interne în traducere, QA și repararea
    // calupurilor. Dacă există duplicate, renumerotăm rezultatul 1..N pentru a avea
    // chei unice și ordine curată în SRT-ul emis; păstrăm sourceId pentru verificările
    // care trebuie să respecte numerotarea și golurile originale. Fișierele normale
    // fără ID-uri duplicate rămân complet neschimbate.
    const seenSourceIds = new Set();
    const duplicateItems = [];
    for (const item of result) {
        const sourceIdKey = String(item.id);
        if (seenSourceIds.has(sourceIdKey)) duplicateItems.push(item);
        else seenSourceIds.add(sourceIdKey);
    }

    if (duplicateItems.length) {
        for (const item of result) item.sourceId = item.id;
        result.forEach((item, index) => { item.id = index + 1; });
        if (stats) stats.duplicateIdsRenumbered = duplicateItems.length;
        console.warn(`[SRT] Au fost găsite ${duplicateItems.length} apariții cu ID duplicat; ID-urile ieșirii au fost normalizate pentru a preveni suprascrierea traducerilor.`);
    }

    return result;
}

// ============================================================
// UTILS & START
// ============================================================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

app.get('/health', (req, res) => {
    res.json({ ok: true, service: 'RO Sub Translator', model: MODEL_NAME, version: manifest.version });
});

const PORT = Number(process.env.PORT) || 7000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`${c.green}🚀 RO Sub Translator v${manifest.version} pornit${c.reset}`);
    console.log(`${c.cyan}🧠 Model Gemini activ: ${MODEL_NAME}${c.reset}`);
});
