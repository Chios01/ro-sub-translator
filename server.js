const express = require('express');
const axios = require('axios');
const Parser = require('srt-parser-2').default;
const path = require('path');
const fs = require('fs');

console.log = (...args) => process.stdout.write(args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ') + '\n');

const app = express();

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    next();
});

// Ruta pentru validarea cheilor (ocolire CORS)
app.get('/validate-key', async (req, res) => {
    const key = req.query.key;
    if (!key) return res.status(400).send('No key provided');

    try {
        const check = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`, { timeout: 5000 });
        if (check.status === 200) {
            return res.json({ valid: true });
        }
    } catch (e) {
        return res.json({ valid: false });
    }
});

const c = {
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m',
    reset: '\x1b[0m'
};

const memoryCache = {}; 
const secretArchive = []; 

const manifest = {
    id: 'community.chios.geminitranslator', 
    version: '2.3.32',
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

const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

app.get('/', (req, res) => {
    fs.readFile(path.join(__dirname, 'index.html'), 'utf8', (err, data) => {
        if (err) return res.sendFile(path.join(__dirname, 'index.html'));
        const updatedHtml = data.replace(/{{VERSION}}/g, manifest.version);
        res.send(updatedHtml);
    });
});

app.get('/:configData/manifest.json', (req, res) => {
    res.json(manifest);
});

app.get('/:configData/configure', (req, res) => {
    fs.readFile(path.join(__dirname, 'index.html'), 'utf8', (err, data) => {
        if (err) return res.sendFile(path.join(__dirname, 'index.html'));
        const updatedHtml = data.replace(/{{VERSION}}/g, manifest.version);
        res.send(updatedHtml);
    });
});

// ==== RUTELE SECRETE PENTRU ARHIVA DE TESTARE ====
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
                <strong style="color:#0bf;">ID: ${item.id}</strong> <span style="color:#888; font-size:0.9em;">(${item.time})</span><br><br>
                <a href="/download-srt/${index}" style="background:#0bf; color:#000; text-decoration:none; padding:8px 12px; border-radius:4px; font-weight:bold;">Descarcă fisier .srt</a>
            </li>`;
        });
        html += '</ul>';
    }
    html += '</body></html>';
    res.send(html);
});

app.get('/download-srt/:index', (req, res) => {
    const index = parseInt(req.params.index);
    if (isNaN(index) || !secretArchive[index]) {
        return res.status(404).send('Fișierul nu există sau a fost șters automat din memorie.');
    }
    const item = secretArchive[index];
    res.setHeader('Content-disposition', `attachment; filename=RO_${item.id}.srt`);
    res.setHeader('Content-type', 'text/plain; charset=utf-8');
    res.send(item.content);
});
// ===================================================

async function handleSubtitles(req, res) {
    const { configData, type, id, extra } = req.params;

    const host = req.headers.host;
    const protocol = host.includes('localhost') || host.includes('127.0.0.1') ? 'http' : 'https';
    const baseUrl = `${protocol}://${host}`;

    let extraString = '';
    let userFilename = '';

    if (extra) {
        extraString = '/' + extra;
        try {
            const params = new URLSearchParams(extra);
            userFilename = params.get('filename') || '';
        } catch (e) {}
    }

    const urlsToFetch = [
        `https://opensubtitles-v3.strem.io/subtitles/${type}/${id}${extraString}.json`, 
        `https://yifysubtitles.strem.io/subtitles/${type}/${id}${extraString}.json`,
        `https://subdl.strem.io/subtitles/${type}/${id}${extraString}.json`
    ];

    try {
        const fetchPromises = urlsToFetch.map(u => 
            axios.get(u, { 
                timeout: 3500, 
                headers: { 'User-Agent': BROWSER_USER_AGENT } 
            }).catch(() => ({ data: { subtitles: [] } }))
        );

        const results = await Promise.all(fetchPromises);
        
        let allSubs = [];
        results.forEach(r => {
            if (r && r.data && Array.isArray(r.data.subtitles)) {
                allSubs.push(...r.data.subtitles);
            }
        });
        
        let engSubs = allSubs.filter(s => s.lang === 'eng' || s.lang === 'en' || s.lang === 'English');
        
        const uniqueUrls = new Set();
        engSubs = engSubs.filter(sub => {
            if (uniqueUrls.has(sub.url)) return false;
            uniqueUrls.add(sub.url);
            return true;
        }).slice(0, 25); 

        if (engSubs.length === 0) return res.json({ subtitles: [] });

        let diverseSubs = [];
        const trashRegex = /korsub|kor\.sub|hdcam|hd-ts|hdts|camrip|telesync|telecine|hardcoded|hc-eng|hc-sub|hc\.\w+|1xbet/i;

        engSubs.forEach((sub, idx) => {
            let realName = sub.title || sub.id || `Varianta_${idx + 1}`;
            if (!trashRegex.test(realName)) {
                diverseSubs.push({ originalUrl: sub.url, realName, index: idx });
            }
        });

        const fNameLower = userFilename.toLowerCase();
        const videoTokens = fNameLower.split(/[^a-z0-9]+/i).filter(t => t.length > 2 && !/^(mkv|mp4|avi)$/.test(t));

        diverseSubs.forEach(s => {
            s.score = 0;
            const subName = s.realName.toLowerCase();
            
            if (videoTokens.length > 0) {
                let matchCount = 0;
                videoTokens.forEach(token => {
                    if (subName.includes(token)) {
                        s.score += 60; 
                        matchCount++;
                    }
                });
                
                if (matchCount > 0 && matchCount >= videoTokens.length / 2) {
                    s.score += 300; 
                }
            }

            if (/web-dl|webdl|webrip|web|amzn|nf|dsnp|hulu|max/i.test(subName)) s.score += 40;
            if (/bluray|brrip|bdrip|bdr/i.test(subName)) s.score += 30;
            if (/yts|yify|rarbg|tgx|qxr|psa/i.test(subName)) s.score += 20;
            if (/sdh|hi\.|hearing impaired/i.test(subName)) s.score -= 15; 
            if (/sync|corregido|resync|translated|auto|machine/i.test(subName)) s.score -= 100;
        });

        diverseSubs.sort((a, b) => b.score - a.score);
        diverseSubs = diverseSubs.slice(0, 15);

        const generatedSubs = diverseSubs.map((s, index) => {
            const encodedUrl = encodeURIComponent(s.originalUrl);
            
            let vizualName = s.realName.replace(/[^a-zA-Z0-9.-]/g, ' ');
            const tagMatch = vizualName.match(/(2160p|1080p|720p|4k|bluray|web-dl|webrip|hdr|remux)/i);
            
            let labelName = `🇷🇴 RO AI [${index + 1}]`;
            if (tagMatch) {
                let cleanTag = tagMatch[0].toUpperCase();
                labelName = `🇷🇴 RO AI [${index + 1}] • ${cleanTag}`;
            }

            return {
                id: `ai_sub_${index}`,
                title: labelName, 
                url: `${baseUrl}/${configData}/translate?id=${id}&targetUrl=${encodedUrl}&v=${s.index + 1}`,
                lang: 'ron'
            };
        });

        return res.json({ subtitles: generatedSubs });
    } catch (error) {
        return res.json({ subtitles: [] });
    }
}

app.get('/:configData/subtitles/:type/:id.json', handleSubtitles);
app.get('/:configData/subtitles/:type/:id/:extra.json', handleSubtitles);

app.get('/:configData/translate', async (req, res) => {
    const imdbId = req.query.id;
    const targetUrl = req.query.targetUrl;
    const configData = req.params.configData;

    if (!targetUrl) return res.status(400).send('Lipsă URL sursă.');

    let userKeys = [];
    try {
        const decoded = Buffer.from(configData, 'base64').toString('utf8');
        userKeys = JSON.parse(decoded);
    } catch(e) {
        return res.status(400).send('Configurare invalidă. Instalează addon-ul din nou.');
    }

    const cacheKey = targetUrl;

    if (memoryCache[cacheKey] && typeof memoryCache[cacheKey] === 'string') {
        res.setHeader('Content-Type', 'text/srt; charset=utf-8');
        return res.send(memoryCache[cacheKey]);
    }

    res.writeHead(200, {
        'Content-Type': 'text/srt; charset=utf-8',
        'Transfer-Encoding': 'chunked'
    });
    res.flushHeaders(); 

    const keepAlive = setInterval(() => {
        res.write(' \n');
    }, 10000);

    try {
        let processPromise;

        if (memoryCache[cacheKey] && typeof memoryCache[cacheKey] !== 'string') {
            processPromise = memoryCache[cacheKey];
        } else {
            const startTime = Date.now();
            
            processPromise = (async () => {
                const srtRes = await axios.get(targetUrl, {
                    headers: { 'User-Agent': BROWSER_USER_AGENT }
                });
                
                const totalLinesCount = (srtRes.data.match(/-->/g) || []).length;
                console.log(`${c.cyan}\n==================================================${c.reset}`);
                console.log(`${c.magenta}▶ ÎNCEPE PROCESAREA PENTRU: ${imdbId}${c.reset}`);
                console.log(`${c.magenta}📑 Total linii de tradus: ${totalLinesCount}${c.reset}`);
                console.log(`${c.cyan}==================================================\n${c.reset}`);
                
                return await translateSrtWithGemini(srtRes.data, userKeys);
            })();
            
            memoryCache[cacheKey] = processPromise;
            
            processPromise.then(translatedSrtString => {
                memoryCache[cacheKey] = translatedSrtString;
                const durationSeconds = Math.floor((Date.now() - startTime) / 1000);
                let timeFormatted = durationSeconds < 60 ? `${durationSeconds} sec` : `${Math.floor(durationSeconds / 60)} min și ${durationSeconds % 60} sec`;
                
                console.log(`${c.green}\n✔ PROCESARE FINALIZATĂ CU SUCCES PENTRU: ${imdbId}${c.reset}`);
                console.log(`${c.green}⏱ Timp total de traducere: ${timeFormatted}${c.reset}`);
                console.log(`${c.cyan}==================================================\n${c.reset}`);
            }).catch(() => {
                delete memoryCache[cacheKey];
            });
        }

        const finalSrt = await processPromise;
        
        if (finalSrt && finalSrt.trim().length > 0) {
            const now = new Date();
            const timeStr = now.toLocaleTimeString('ro-RO') + ' ' + now.toLocaleDateString('ro-RO');
            
            secretArchive.unshift({
                id: imdbId,
                time: timeStr,
                content: finalSrt
            });
            
            if (secretArchive.length > 10) {
                secretArchive.pop();
            }
        }

        clearInterval(keepAlive);
        res.write(finalSrt);
        res.end();

    } catch (error) {
        clearInterval(keepAlive);
        res.end(); 
    }
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
    console.log(`${c.green}✔ Serverul rulează pe portul: ${PORT}${c.reset}`);
});

function cleanTextForJson(text) {
    if (!text) return text;
    let clean = text;

    clean = clean.replace(/<[^>]+>/g, '');
    
    clean = clean.replace(/[♪♫♬♩#]/gi, '');
    clean = clean.replace(/â™ª/gi, '');
    clean = clean.replace(/â™«/gi, '');
    clean = clean.replace(/\[\s*[♪♫♬♩#]+\s*\]/gi, '');
    clean = clean.replace(/\(\s*[♪♫♬♩#]+\s*\)/gi, '');
    clean = clean.replace(/\[.*music.*\]/gi, ''); 

    clean = clean.replace(/\[[\s\S]*?\]/g, ''); 
    clean = clean.replace(/\([\s\S]*?\)/g, ''); 
    clean = clean.replace(/\{[\s\S]*?\}/g, ''); 
    clean = clean.replace(/【[\s\S]*?】/g, ''); 
    
    clean = clean.replace(/^[A-Z0-9\s-]{2,}:/gm, '');
    clean = clean.replace(/"/g, "'");

    let lines = clean.split('\n');
    lines = lines.map(line => {
        let l = line.trim();
        
        let changed = true;
        while(changed) {
            const match = l.match(/^([-—–−\s]*)(oh+|ah+|ooh+|aah+|uh+|ugh+|hm+|um+|mm+|mhm+|eh+|wow+|hey+|shh+)[.,!?\s]*(.*)$/i);
            if (match) {
                l = match[1] + match[3].trim();
            } else {
                changed = false;
            }
        }

        if (/^[-—–−.,!?\s]*$/.test(l)) {
            return '';
        }
        
        l = l.replace(/[♪♫♬♩#]/gi, '');
        l = l.replace(/\[\s*\]/g, ''); 
        l = l.replace(/\(\s*\)/g, '');
        
        return l;
    });

    let validLines = lines.filter(l => l !== '');
    
    validLines = validLines.map(l => {
        if (/^[-—–−]/.test(l)) {
            return l.replace(/^[-—–−]+\s*/, '- '); 
        }
        return l;
    });

    clean = validLines.join('\n');

    if (clean.trim() === '') return ' ';
    return clean.trim();
}

function chunkArray(array, size) {
    const result = [];
    for (let i = 0; i < array.length; i += size) {
        result.push(array.slice(i, i + size));
    }
    return result;
}

function formatSubtitleLine(text) {
    if (!text) return text;
    
    text = text.replace(/ţ/g, 'ț').replace(/Ţ/g, 'Ț').replace(/ş/g, 'ș').replace(/Ş/g, 'Ș');
    text = text.replace(/<[^>]+>/g, '');
    text = text.replace(/([.?!])\s+[-—–−]\s+([A-ZĂÂÎȘȚ])/g, '$1\n- $2');

    let lines = text.split('\n');
    lines = lines.map(l => {
        let cl = l.trim();
        if (/^([-—–−\s]*)(ă+|m+|mm+|îm+|îhî|aha|mda|oh+|ah+|um+|hm+)[.,!?\s]*$/i.test(cl)) return '';
        if (/^[-—–−.,!?\s]*$/.test(cl)) return '';
        return cl;
    });
    
    let validLines = lines.filter(l => l !== '');
    
    let mergedText = '';
    for (let i = 0; i < validLines.length; i++) {
        let l = validLines[i];
        if (i === 0) {
            mergedText = l;
        } else {
            if (/^[-—–−]/.test(l)) { 
                mergedText += '\n' + l;
            } else {
                mergedText += ' ' + l; 
            }
        }
    }
    
    let finalMergedLines = mergedText.split('\n');
    finalMergedLines = finalMergedLines.map(l => {
        return l.trim().replace(/^[-—–−]+\s*/g, ''); 
    });
    
    text = finalMergedLines.join('\n');
    
    text = text.replace(/[♪♫♬♩#]/gi, '');
    text = text.replace(/\[[\s\S]*?\]/g, ''); 
    text = text.replace(/\([\s\S]*?\)/g, '');

    const rw = (txt, search, replace, flags='g') => {
        const regex = new RegExp(`(^|[^a-zA-Z0-9ăâîșțĂÂÎȘȚ])(${search})(?=[^a-zA-Z0-9ăâîșțĂÂÎȘȚ]|$)`, flags);
        return txt.replace(regex, `$1${replace}`);
    };

    text = rw(text, 'ăă', '', 'gi');
    text = rw(text, 'hă', '', 'gi');
    text = text.replace(/P-Păi/gi, 'Păi');
    text = text.replace(/[wW]-Well/g, 'Păi');

    text = rw(text, 'from', 'de la', 'gi');
    text = rw(text, 'kensevasem', 'convinsesem', 'gi');
    text = rw(text, 'prăjicina', 'prăjiturica', 'gi');
    text = text.replace(/zămislirea asta/gi, 'porcăria asta');
    text = text.replace(/onoare apre noastre/gi, 'onoarea noastră');
    text = rw(text, 'zărelul', 'zahărelul', 'gi');
    text = rw(text, 'acor', 'acestor', 'gi');
    text = rw(text, 'ketchuipurile', 'ketchupurile', 'gi');
    text = rw(text, 'rțuire', 'hărțuire', 'gi');
    text = rw(text, 'bacterijle', 'bacteriile', 'gi');
    text = text.replace(/probleme cu rțile/gi, 'probleme cu știrile');
    text = rw(text, 'rțile', 'știrile', 'gi');
    text = rw(text, 'nhưng', 'dar', 'gi');
    text = rw(text, 'nithe', 'niște', 'gi');
    text = rw(text, 'Stucați', 'Scuzați', 'gi');
    text = rw(text, 'putemos', 'putem', 'gi');
    text = rw(text, 'Robinei', 'lui Robin', 'gi');
    text = rw(text, 'măsurą', 'măsura', 'gi');
    text = rw(text, 'să fiică', 'să fie', 'gi');
    text = text.replace(/lemnul de divorț/gi, 'divorț');
    text = rw(text, 'Poftă\\?', 'Poftim?', 'gi');
    text = rw(text, 'dădadă', 'dădacă', 'gi');
    text = rw(text, 'să se fină', 'să se prefacă', 'gi');
    text = rw(text, 'bet merici', 'dar meriți', 'gi');
    text = rw(text, 'usile', 'ușile', 'gi');

    // Marea curățenie The Boys
    text = text.replace(/în toată regla/gi, 'în toată regula');
    text = text.replace(/sunt extinși/gi, 'sunt pe cale de dispariție');
    text = text.replace(/Nu-mi vine să crezi/gi, 'Nu-mi vine să cred');
    text = text.replace(/Bâțâială fină/gi, 'Râgâială fină');
    text = text.replace(/Aia e [sS]ânul meu/gi, 'Ăla e sânul meu');
    text = text.replace(/ție datorităție/gi, 'datorită ție');
    text = text.replace(/îndoaie-te cu toate astea/gi, 'servește-te cu toate astea');
    text = rw(text, 'natătăfleață', 'nătăfleață', 'gi');
    text = text.replace(/cuțitul de pernă/gi, 'cuțitul de sub pernă');
    text = text.replace(/și-a predat în sfârșit pantofii/gi, 'a dat ortul popii');

    text = text.replace(/Atunci\s+spune[tț]i\s+c[aă][\s.,]+(Glumi[tț]i|Jumi[tț]i|Jeta[tț]i|Jre[tț]i|Jne|[Jj]ă)\.?/gi, 'Atunci spuneți că vă pare rău.');
    text = text.replace(/Trebuie\s+să\s+mă\s+(prefac|fac)\s+parcă\s+nu\s+s-a\s+întâmplat/gi, 'Trebuie să mă prefac că nu s-a întâmplat');
    text = text.replace(/parcă\s+nu\s+țțineam\s+brațele\s+lui\s+Robin\s+în\s+mâinile\s+mele/gi, 'că nu țineam brațele lui Robin în mâinile mele');

    text = rw(text, 'Jreți', 'vă', 'gi');
    text = rw(text, '[Jj]ă', 'vă', 'g');
    text = rw(text, 'Jți', 'Îți', 'g');
    text = rw(text, 'jți', 'îți', 'g');
    text = rw(text, 'Jne', 'vă', 'gi');
    text = rw(text, 'Jetați', 'vă pare rău', 'gi');

    text = rw(text, 'ineam', 'țineam', 'g');
    text = rw(text, 'Ineam', 'Țineam', 'g');
    text = text.replace(/țțineam/gi, 'țineam'); 
    text = text.replace(/Țțineam/g, 'Țineam');

    text = text.replace(/mă fac că nu/gi, 'mă prefac că nu');
    text = text.replace(/prefac parcă/gi, 'prefac de parcă');
    
    text = text.replace(/spune[tț]i\s+c[aă]\s+[îÎ]ți\s+pare/gi, 'spuneți că vă pare');

    // === CORECȚII GENERALE CRATIME LIPSĂ (Plasa de siguranță) ===
    const cratime = ['s a', 's au', 'm am', 'm a', 'm ai', 'n am', 'n a', 'n au', 'n ai', 'n o', 'l a', 'l am', 'l au', 'l ai', 'v ați', 'ne am', 'ne a', 'mi a', 'mi au', 'ți a', 'ți au', 'i a', 'i au'];
    cratime.forEach(combo => {
        text = rw(text, combo, combo.replace(' ', '-'), 'gi');
    });
    
    text = rw(text, 'îmbrăcați vă', 'îmbrăcați-vă', 'gi');
    text = rw(text, 'luându ți', 'luându-ți', 'gi');
    
    // === CORECȚII HALUCINAȚII DIVERSE ȘI TRADUCERI LITERALE ===
    text = text.replace(/ą/g, 'ă').replace(/Ą/g, 'Ă');
    text = rw(text, 'alcineva', 'altcineva', 'gi');
    text = rw(text, 'paranoi', 'paranoia', 'gi');
    text = rw(text, 'nicideun loc', 'nicăieri', 'gi');
    text = text.replace(/ți se sângereze/gi, 'îți sângereze');
    text = text.replace(/să le urmat/gi, 'să le urmez');
    text = text.replace(/\bman\s+pas[aă]/gi, 'îmi pasă');
    text = text.replace(/\bman\s+pl[aă]cem/gi, 'îmi placi');
    
    // Corecturi specifice textului 2 Broke Girls
    text = rw(text, 'înulam', 'comandam', 'gi');
    text = rw(text, 'poșta mea preferată', 'poșeta mea preferată', 'gi');
    text = text.replace(/un acnee/gi, 'o acnee');
    text = text.replace(/umele dinților/gi, 'numele dinților');
    text = text.replace(/cântec a lui/gi, 'cântec al lui');
    text = text.replace(/cam aștia/gi, 'cam ăsta');
    text = text.replace(/Obișnuiam să mă furișam/gi, 'Obișnuiam să mă furișez');
    text = text.replace(/Ștergelui total/gi, 'Șterpelind');

    text = text.replace(/lăsându-se pe o mână/gi, 'făcând o labă');
    text = text.replace(/mănânci curul meu încordat/gi, 'mă pupi în cur');
    text = text.replace(/Băiete,\s*mamii\s*tale/gi, 'Futu-i mama mă-sii');

    // Corecturi specifice The Ark / Scrubs / The Boys / X-Men / Unabomber / Horror etc.
    text = text.replace(/kconvinsesem/gi, 'convinsesem');
    text = text.replace(/moști/gi, 'morți');
    text = text.replace(/un femeie/gi, 'o femeie');
    text = text.replace(/o a s[aă]rut/gi, 'o s-o sărut');
    text = text.replace(/resemnând/gi, 'referitor la');
    text = text.replace(/unindiciu/gi, 'un indiciu');
    text = text.replace(/să sperezi/gi, 'să speri');
    text = text.replace(/la ținut/gi, 'l-a ținut');
    text = text.replace(/S-ar pulea/gi, 'S-ar putea');
    text = text.replace(/lărimile/gi, 'lacrimile');
    text = text.replace(/ute-ai/gi, 'te-ai');
    text = text.replace(/construgeam/gi, 'construiam');
    text = text.replace(/pătură dracului/gi, 'pătura dracului');
    text = text.replace(/ca cadou/gi, 'drept cadou');
    text = text.replace(/șneșteai/gi, 'regulai');
    text = text.replace(/N-ai știi/gi, 'N-ai ști');
    text = text.replace(/I-a ținuți/gi, 'I-a ținut');
    text = text.replace(/Bivolă/gi, 'Vacă');
    text = text.replace(/Vreo, Vought/gi, 'Frate, Vought');
    text = text.replace(/Supei/g, 'Eroii');
    text = text.replace(/Privire de tigru/gi, 'Ochi de tigru');
    text = text.replace(/I tu, neurotico, circ de o singură femeie/gi, 'Iar tu, neurotico, ești un circ ambulant');
    text = text.replace(/Dă cu teancul acela în palmă/gi, 'Lovește teancul de palmă');
    text = text.replace(/căci capul lui e/gi, 'pentru că are capul');
    text = rw(text, 'butorii', 'băutorii', 'gi');
    text = text.replace(/am\s+fost\s+alege[tț]i/gi, 'am fost aleși');
    text = text.replace(/tras\s+în\s+piepie/gi, 'tras în piept');
    text = rw(text, 'penthaină', 'penthouse', 'gi');
    text = rw(text, 'drum runner', 'Road Runner', 'gi');
    text = text.replace(/c[aă]ntat\s+la\s+fund\s+ca\s+la\s+jazz/gi, 'cântat la fund ca la un instrument');
    
    // Calupul nou de corecții (X-Men, Unabomber, Ungentlemanly Warfare, The Boy Behind the Door)
    text = rw(text, 'nebunizați', 'nebuni', 'gi');
    text = rw(text, 'raiuk', 'raiul', 'gi');
    text = rw(text, 'Iafu', 'Iau', 'gi');
    text = rw(text, 'uniții', 'muniții', 'gi');
    text = text.replace(/filetat\s+vânat/gi, 'jupuit vânat');
    text = rw(text, 'U-barce', 'U-boot-uri', 'gi');
    text = rw(text, 'U-barc', 'U-boot', 'gi');
    text = text.replace(/să\s+fieți\s+educați/gi, 'să fiți educați');
    text = text.replace(/Lăsați-mi-vă\s+să\s+vă\s+arăt/gi, 'Lăsați-mă să vă arăt');
    text = rw(text, 'misia', 'misiunea', 'gi');
    text = text.replace(/Senatule/gi, 'Senatorule');
    text = rw(text, 'Roți', 'Wheels', 'g');
    text = text.replace(/M,\s*,\s*\./g, '');
    text = text.replace(/tristă\s+și\s+supărați/gi, 'triști și supărați');
    text = rw(text, 'abnormal', 'anormal', 'gi');
    text = text.replace(/toate\s+liberul\s+arbitru/gi, 'tot liberul arbitru');
    text = rw(text, 'ecanarhiști', 'eco-anarhiști', 'gi');
    text = text.replace(/ridică\s+balena\s+albă/gi, 'zărește balena albă');
    text = text.replace(/să\s+defin\b/gi, 'să definim');
    text = text.replace(/(Nu, trebuie să răspunzi, altfel pierzi punctele\.?\s*){2,}/gi, 'Nu, trebuie să răspunzi, altfel pierzi punctele.\n');

    text = text.replace(/\b1(?=[a-zăâîșțĂÂÎȘȚ]{2,})/gi, ''); 
    text = rw(text, '1-ar', 'l-ar', 'gi');
    text = rw(text, 'aire', 'ai', 'g');
    text = rw(text, 'Aire', 'Ai', 'g');
    text = rw(text, 'aver', 'ai', 'g');
    text = rw(text, 'Aver', 'Ai', 'g');
    text = text.replace(/man spui/gi, 'îmi spui');
    text = rw(text, 'Îcerci', 'Încerci', 'g');
    text = rw(text, 'îcerci', 'încerci', 'g');
    text = text.replace(/Fă-ca acasă/gi, 'Simte-te ca acasă');
    text = rw(text, 'să suferit', 'să sufăr', 'gi');
    text = rw(text, 'cev', 'ceva', 'gi');
    text = rw(text, 'săcerci', 'să încerci', 'gi');
    text = rw(text, 'Jumiți', 'Glumiți', 'g');
    text = rw(text, 'jumiți', 'glumiți', 'g');
    text = text.replace(/ât ai clipi/gi, 'cât ai clipi');
    text = rw(text, 'vumat', 'vomat', 'gi');
    text = rw(text, 'unzn', 'un', 'gi');
    text = text.replace(/să veimă mănânci/gi, 'să mănânci');
    text = text.replace(/ești nevoie/gi, 'este nevoie');
    text = rw(text, 'știen', 'știm', 'gi');
    text = rw(text, 'cafond', 'profund', 'gi');
    text = text.replace(/să fi ratat-o/gi, 'să fi ratat');
    text = text.replace(/Mă pornesc la trei/gi, 'Pornesc la trei');
    text = rw(text, 'urdă', 'undă', 'gi');
    text = rw(text, 'ți vei', 'îți vei', 'gi');
    text = text.replace(/nu toată binevenită/gi, 'nu tocmai binevenită');
    text = rw(text, 'nu mai te', 'nu te mai', 'gi');
    text = rw(text, 'sâniile mele', 'sânii mei', 'gi');
    text = rw(text, 'sâniile', 'sânii', 'gi');

    text = text.replace(/,\s*,/g, ',');
    text = text.replace(/\s+,/g, ',');
    text = text.replace(/\s+\?/g, '?');
    text = text.replace(/\s+\./g, '.');
    text = text.replace(/ +/g, ' '); 
    
    text = text.replace(/[^\u0000-\u024F\u2000-\u206F\u2E00-\u2E7F\n\r]/g, "");

    if (text.trim() === '') return ' '; 

    let finalLines = text.split('\n').map(l => l.trim()).filter(l => l !== '');
    const MAX_LEN = 45; 
    let wrappedLines = [];

    for (let line of finalLines) {
        if (line.length <= MAX_LEN) {
            wrappedLines.push(line);
        } else {
            let mid = Math.floor(line.length / 2);
            let leftSpace = line.lastIndexOf(' ', mid);
            let rightSpace = line.indexOf(' ', mid);
            let splitIndex = -1;

            if (leftSpace !== -1 && rightSpace !== -1) {
                splitIndex = (mid - leftSpace) <= (rightSpace - mid) ? leftSpace : rightSpace;
            } else if (leftSpace !== -1) {
                splitIndex = leftSpace;
            } else if (rightSpace !== -1) {
                splitIndex = rightSpace;
            }

            if (splitIndex !== -1) {
                wrappedLines.push(line.substring(0, splitIndex).trim());
                wrappedLines.push(line.substring(splitIndex + 1).trim());
            } else {
                wrappedLines.push(line); 
            }
        }
    }

    return wrappedLines.map(l => l.replace(/^[-—–−]+\s*/g, '')).join('\n');
}

function fixBrokenJson(text) {
    let fixed = text;
    fixed = fixed.replace(/"(\d+)":\s*([^",}\n]+)([,}\n])/g, function(match, key, value, terminator) {
        let cleanVal = value.trim();
        if (!cleanVal.startsWith('"')) {
            cleanVal = cleanVal.replace(/^b['"]|['"]$/g, '');
            return `"${key}": "${cleanVal}"${terminator}`;
        }
        return match;
    });
    return fixed;
}

let globalRateLimitPause = 0;

async function processChunkWithRetry(chunkObjArray, globalChunkIndex, totalChunks, keyState) {
    let keysToTranslate = {};
    chunkObjArray.forEach(obj => {
        keysToTranslate[obj.id] = obj.text;
    });

    let finalTranslatedDict = {};
    let expectedTotalCount = Object.keys(keysToTranslate).length;
    let attempts = 0;
    let contentErrorCount = 0; 
    const maxAttempts = 15; 

    while (Object.keys(keysToTranslate).length > 0 && attempts < maxAttempts) {
        
        let batchToProcess = {};
        const allKeys = Object.keys(keysToTranslate);
        
        if (contentErrorCount >= 2 && allKeys.length > 5) {
            console.log(`${c.yellow}⚠ [Gemini] Calupul ${globalChunkIndex + 1} pare blocat de format. Îl împart pentru a izola problema...${c.reset}`);
            const halfLength = Math.floor(allKeys.length / 2);
            for (let i = 0; i < halfLength; i++) {
                batchToProcess[allKeys[i]] = keysToTranslate[allKeys[i]];
            }
            contentErrorCount = 0; 
        } else {
            batchToProcess = Object.assign({}, keysToTranslate);
        }

        while (Date.now() < globalRateLimitPause) {
            await new Promise(r => setTimeout(r, 1000));
        }

        let currentKeyObj = null;
        let keyIndex = -1;
        let apiKey = null;

        while (true) {
            let availableIndices = [];
            for (let i = 0; i < keyState.keys.length; i++) {
                if (Date.now() >= keyState.keys[i].pauseUntil) {
                    availableIndices.push(i);
                }
            }

            if (availableIndices.length > 0) {
                let randomIndex = Math.floor(Math.random() * availableIndices.length);
                keyIndex = availableIndices[randomIndex];
                currentKeyObj = keyState.keys[keyIndex];
                apiKey = currentKeyObj.value;

                currentKeyObj.pauseUntil = Date.now() + 1500;
                break;
            }

            await new Promise(r => setTimeout(r, 1000));
        }

        // Varianta "full", dar setată la un calup pe rând în funcția de mai jos
        const modelName = 'gemini-3.5-flash';
        let currentBatchSize = Object.keys(batchToProcess).length;

        try {
            if (currentBatchSize === expectedTotalCount) {
                console.log(`${c.cyan}➤ [Gemini] Traduc calup ${globalChunkIndex + 1}/${totalChunks} (Model: ${modelName} | Cheie: ${keyIndex})...${c.reset}`);
            } else {
                console.log(`${c.magenta}↻ [Gemini] Recuperez ${currentBatchSize} linii omise pentru calupul ${globalChunkIndex + 1}...${c.reset}`);
            }
            
            const prompt = `Translate the following English subtitles into natural, conversational Romanian.

RULES:
1. DIACRITICS, SPELLING & GRAMMAR (CRITICAL): Use correct Romanian diacritics (ă, â, î, ș, ț). Ensure PERFECT Romanian spelling and grammar. CRITICAL: NEVER omit hyphens (cratimă) for pronouns and auxiliary verbs (e.g., MUST write 's-a', 'm-am', 'n-am', 'dându-și', 'îmbrăcați-vă' - NEVER 's a', 'm am'). Use standard, dictionary-approved vocabulary.
2. CHARACTER NAMES (CRITICAL): DO NOT translate character names (e.g. Homelander, Butcher, Starlight, Hughie, A-Train). Leave them exactly as they are in English.
3. GENDER BLINDNESS: You cannot see the video. To avoid gender mistakes for "I", use neutral phrasing ("Mi-am primit banii" instead of "Am fost plătit/plătită").
4. TV BROADCAST CENSORSHIP & SLANG: Soften extreme vulgarities to maintain civilized language, but preserve the scene's dark or tense tone. DO NOT translate English idioms or slang literally (e.g. 'jerking off' is NOT 'lăsându-se pe o mână'). Use natural Romanian equivalents. Omit swear words entirely if they are just filler words. "Why do I give a shit?" = "Ce-mi pasă mie?". "Man" = "omule". 
5. NOISES, HESITATIONS & STUTTERS: Completely remove audio tags like [music]. Completely remove ALL hesitations, stutters, and interjections (e.g., Oh, Ah, Uh, Ăă, hă) from EVERYWHERE in the sentence.
6. NO DIGITS IN WORDS: Never put numbers inside words. 
7. STRICT ACCURACY (CRITICAL): DO NOT invent words (e.g. do not write 'unzn' instead of 'un'). DO NOT skip letters. DO NOT replace the letter 'L' with the number '1' (e.g. write 'l-ar', never '1-ar'). Check your spelling carefully before outputting the JSON.
8. FORMAT: You MUST reply ONLY with a valid JSON object. Keep the exact same keys as the input. Do NOT add extra text.

Input JSON:
${JSON.stringify(batchToProcess)}`;

            const response = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
                {
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { 
                        response_mime_type: "application/json",
                        temperature: 0.1 
                    },
                    safetySettings: [
                        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                    ]
                },
                { 
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 120000 
                }
            );

            if (!response.data || !response.data.candidates || response.data.candidates.length === 0 || !response.data.candidates[0].content) {
                if (response.data && response.data.promptFeedback && response.data.promptFeedback.blockReason) {
                    throw new Error(`Filtrat de Google (${response.data.promptFeedback.blockReason})`);
                }
                throw new Error("Răspuns invalid sau gol primit de la API.");
            }

            let textResponse = response.data.candidates[0].content.parts[0].text;
            
            let startIndex = textResponse.indexOf('{');
            let endIndex = textResponse.lastIndexOf('}');

            if (startIndex !== -1 && endIndex !== -1) {
                textResponse = textResponse.substring(startIndex, endIndex + 1);
            }

            let parsedDict = {};
            try {
                let cleanText = fixBrokenJson(textResponse);
                parsedDict = JSON.parse(cleanText);
            } catch (e) {
                const keys = Object.keys(batchToProcess);
                for (let i = 0; i < keys.length; i++) {
                    const key = keys[i];
                    const nextKey = keys[i + 1];
                    
                    let lookahead = `\\s*\\}|$)`;
                    if (nextKey) {
                        lookahead = `\\s*,?\\s*"?(?:${nextKey})"?\\s*:|\\s*\\}|$)`;
                    }
                    
                    const regex = new RegExp(`"?${key}"?\\s*:\\s*(.*?)(?=${lookahead}`, 's');
                    const match = textResponse.match(regex);
                    if (match) {
                        let val = match[1].trim();
                        if (val.endsWith(',')) val = val.substring(0, val.length - 1).trim();
                        if (val.startsWith('"') || val.startsWith("'")) val = val.substring(1);
                        if (val.endsWith('"') || val.endsWith("'")) val = val.substring(0, val.length - 1);
                        val = val.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\'/g, "'");
                        parsedDict[key] = val.trim();
                    }
                }
            }

            let newlyTranslatedCount = 0;
            for (let key in parsedDict) {
                if (keysToTranslate[key] !== undefined) {
                    finalTranslatedDict[key] = parsedDict[key];
                    delete keysToTranslate[key]; 
                    newlyTranslatedCount++;
                }
            }

            if (newlyTranslatedCount === 0) {
                throw new Error("Nu a extras nicio linie validă.");
            } else {
                attempts = 0;
                contentErrorCount = 0;
            }

            if (Object.keys(keysToTranslate).length === 0) {
                console.log(`${c.green}✔ [Gemini] Calup ${globalChunkIndex + 1}/${totalChunks} finalizat! (${expectedTotalCount}/${expectedTotalCount} linii)${c.reset}`);
                break; 
            } 

        } catch (error) {
            attempts++;
            if (attempts >= maxAttempts) {
                console.log(`${c.red}✖ [Gemini] Limita atinsă pentru calupul ${globalChunkIndex + 1}. Abandon!${c.reset}`);
                break; 
            }

            if (error.response && error.response.status === 429) {
                currentKeyObj.pauseUntil = Date.now() + 61000;
                globalRateLimitPause = Math.max(globalRateLimitPause, Date.now() + 10000);
                const sleepTime = Math.floor(10000 + Math.random() * 5000);
                console.log(`${c.yellow}⚠ [Gemini] 429! Cheia ${keyIndex} pe bancă. Calmez IP-ul 10s... (Aștept ${(sleepTime/1000).toFixed(1)}s)${c.reset}`);
                await new Promise(r => setTimeout(r, sleepTime));
            } else if (error.response && error.response.status === 503) {
                const waitTime = 3000 + (attempts * 1500);
                console.log(`${c.yellow}⚠ [Gemini] 503 Server Google ocupat. Aștept ${(waitTime/1000).toFixed(1)}s (${attempts}/${maxAttempts})...${c.reset}`);
                await new Promise(r => setTimeout(r, waitTime));
            } else if (error.message && error.message.toLowerCase().includes('timeout')) {
                console.log(`${c.yellow}⚠ [Gemini] Timeout. Reîncercare (${attempts}/${maxAttempts})...${c.reset}`);
                await new Promise(r => setTimeout(r, 2000));
            } else {
                contentErrorCount++;
                console.log(`${c.magenta}⚠ [Gemini] Eroare format/cenzură. Reîncercare (${attempts}/${maxAttempts})...${c.reset}`);
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }

    const finalTranslatedArray = chunkObjArray.map(obj => {
        return finalTranslatedDict[obj.id] !== undefined ? finalTranslatedDict[obj.id] : obj.text;
    });

    return finalTranslatedArray;
}

async function translateSrtWithGemini(srtText, userKeys) {
    const parser = new Parser();
    const blocks = parser.fromSrt(srtText);
    
    const textsToTranslate = blocks.map((b, index) => {
        return { id: index, text: cleanTextForJson(b.text) };
    });
    
    const CHUNK_SIZE = 165; 
    const chunks = chunkArray(textsToTranslate, CHUNK_SIZE);
    
    // Setat la 1 conform cerinței "calup cu calup"
    let CONCURRENCY_LIMIT = 1; 

    let allTranslatedTexts = [];

    const keyState = { 
        keys: userKeys.map(k => ({ value: k, pauseUntil: 0 })), 
        index: 0 
    };

    for (let i = 0; i < chunks.length; i += CONCURRENCY_LIMIT) {
        const batchChunks = chunks.slice(i, i + CONCURRENCY_LIMIT);
        const batchPromises = batchChunks.map((chunk, indexInBatch) => {
            return processChunkWithRetry(chunk, i + indexInBatch, chunks.length, keyState);
        });
        
        const batchResults = await Promise.all(batchPromises);
        batchResults.forEach(translatedTextsArray => {
            allTranslatedTexts.push(...translatedTextsArray);
        });
    }

    blocks.forEach((block, index) => {
        let finalStr = allTranslatedTexts[index];
        
        if (finalStr === undefined || finalStr === null) {
            finalStr = block.text;
        }
        
        block.text = formatSubtitleLine(finalStr);
    });

    return parser.toSrt(blocks);
}
