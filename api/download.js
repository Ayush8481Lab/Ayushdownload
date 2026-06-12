const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const crypto = require('crypto');
const NodeID3 = require('node-id3');

// VERCEL HACK: Copy FFmpeg safely
const tmpFfmpegPath = '/tmp/ffmpeg';
try {
    if (!fs.existsSync(tmpFfmpegPath)) {
        fs.copyFileSync(ffmpegPath, tmpFfmpegPath);
        fs.chmodSync(tmpFfmpegPath, 0o755); 
    }
    ffmpeg.setFfmpegPath(tmpFfmpegPath);
} catch (error) {
    console.error("Failed to setup FFmpeg in /tmp:", error);
    ffmpeg.setFfmpegPath(ffmpegPath);
}

// Helper: Converts time string "01:25.97" into milliseconds for ID3 Sync
const convertTimeTagToMs = (timeTag) => {
    if (!timeTag) return 0;
    const parts = timeTag.split(':');
    if (parts.length >= 2) {
        const minutes = parseInt(parts[0], 10);
        const seconds = parseFloat(parts[1]);
        return Math.floor((minutes * 60 + seconds) * 1000);
    }
    return 0;
};

module.exports = async (req, res) => {
    try {
        let { url, format, imageUrl, title, tittle, artist, album, trackid } = req.query;

        if (!url) return res.status(400).json({ error: "Missing M3U8 url parameter" });
        if (!url.startsWith('http')) url = 'https://' + url;

        // Strictly clean HTTP header breaking characters
        const cleanStr = (str) => String(str).replace(/[=;#\\\"\n\r,]/g, "").trim();
        const songTitle = cleanStr(title || tittle || 'Unknown Title');
        const songArtist = cleanStr(artist || 'Unknown Artist');
        const songAlbum = cleanStr(album || 'Unknown Album');
        
        const outputFormat = 'mp3'; 
        // Generates a random string suffix to bypass Mi Music's aggressive file caching!
        const safeFileName = `${songTitle.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/ /g, "_")}_${crypto.randomBytes(2).toString('hex')}`;

        let targetBitrate = '320k'; 
        const qualityMatch = url.match(/\/(\d+)\.mp4/);
        if (qualityMatch && qualityMatch[1]) {
            targetBitrate = `${qualityMatch[1]}k`; 
        }

        // --- PARALLEL NETWORK REQUESTS (WITH TIMEOUTS) ---
        const fetchTasks = [];
        let imageBuffer = null;
        let imageMime = 'image/jpeg';
        let lyricsData = null;

        if (imageUrl) {
            if (!imageUrl.startsWith('http')) imageUrl = 'https://' + imageUrl;
            fetchTasks.push(
                fetch(imageUrl, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(4000) })
                    .then(async imgRes => {
                        if (imgRes.ok) {
                            const contentType = imgRes.headers.get('content-type') || '';
                            if (contentType.includes('webp')) imageMime = 'image/webp';
                            else if (contentType.includes('png')) imageMime = 'image/png';
                            
                            imageBuffer = Buffer.from(await imgRes.arrayBuffer());
                        }
                    }).catch(e => console.error("Image fetch failed"))
            );
        }

        if (trackid) {
            const lyricsUrl = `https://lyr-nine.vercel.app/api/lyrics?url=https://open.spotify.com/track/${trackid}&format=lrc`;
            fetchTasks.push(
                fetch(lyricsUrl, { signal: AbortSignal.timeout(4000) })
                    .then(async lyrRes => {
                        if (lyrRes.ok) lyricsData = await lyrRes.json();
                    }).catch(e => console.error("Lyrics fetch failed"))
            );
        }

        await Promise.allSettled(fetchTasks);

        // --- BUILD STRICT LRC FORMAT & IN-MEMORY ID3 ---
        const id3Tags = {
            title: songTitle,
            artist: songArtist,
            album: songAlbum,
            performerInfo: songArtist 
        };

        if (imageBuffer) {
            id3Tags.image = {
                mime: imageMime,
                type: { id: 3, name: 'front cover' },
                description: 'Cover Art',
                imageBuffer: imageBuffer
            };
        }

        if (lyricsData && lyricsData.lines && lyricsData.lines.length > 0) {
            // 1. BUILD STRICT LRC FORMAT (No spaces after colons, No unknown tags!)
            let lrcTextVal = `[ar:${songArtist}]\n`;
            lrcTextVal += `[al:${songAlbum}]\n`;
            lrcTextVal += `[ti:${songTitle}]\n`;
            lrcTextVal += `[au:${songArtist}]\n`;

            const lastLine = lyricsData.lines[lyricsData.lines.length - 1];
            if (lastLine && lastLine.timeTag) {
                const timeMatch = lastLine.timeTag.match(/(\d{2}:\d{2})/);
                if (timeMatch) lrcTextVal += `[length:${timeMatch[1]}]\n`;
            }
            lrcTextVal += `\n`; // Empty line before lyrics start
            
            lrcTextVal += lyricsData.lines.map(l => {
                const time = l.timeTag ? `[${l.timeTag}]` : '[00:00.00]';
                const words = l.words ? l.words.trim() : ''; 
                return `${time}${words || ' '}`; // Blank space prevents crash on empty lyrical lines
            }).join('\n');

            // 2. PRIMARY LYRICS INJECTION (Mi Music / Standard Android)
            id3Tags.unsynchronisedLyrics = {
                language: 'XXX',     // "XXX" = All Languages. Forces Android to read it regardless of system language.
                shortText: '',       // Mi Music requires this to be strictly empty
                text: lrcTextVal
            };

            // 3. SECONDARY LYRICS INJECTION (Vivo Music / Oppo Music Fallback)
            id3Tags.userDefinedText = [{
                description: 'LYRICS',
                value: lrcTextVal
            }];

            // 4. TERTIARY BINARY SYNC 
            if (lyricsData.syncType === "LINE_SYNCED") {
                id3Tags.synchronisedLyrics = [{
                    language: 'eng',
                    timeStampFormat: 2,
                    contentType: 1,
                    synchronisedText: lyricsData.lines.map(l => ({
                        text: l.words || ' ',
                        timeStamp: convertTimeTagToMs(l.timeTag)
                    }))
                }];
            }
        }

        const id3HeaderBuffer = NodeID3.create(id3Tags);

        // --- INSTANT STREAMING ---
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}.${outputFormat}"`);
        res.setHeader('Content-Type', 'audio/mpeg');

        // Send the ID3 Tag Header immediately!
        res.write(id3HeaderBuffer);

        // --- FFMPEG PIPELINE ---
        ffmpeg(url)
            .inputOptions([
                '-allowed_extensions', 'ALL',
                '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
                '-headers', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\r\n',
                '-reconnect', '1',
                '-reconnect_streamed', '1',
                '-reconnect_delay_max', '5'
            ])
            .outputOptions([
                '-vn',                   
                '-f', 'mp3',             
                '-c:a', 'libmp3lame',    
                '-b:a', targetBitrate,   
                '-map_metadata', '-1',     // Strip M3U8 metadata
                '-write_id3v2', '0',       // CRITICAL: Stop FFmpeg from generating a blank ID3 tag that overwrites NodeID3
                '-write_id3v1', '0',       // Stop legacy tags
                '-threads', '1'          
            ])
            .on('error', (err) => {
                console.error('FFmpeg Error:', err.message);
                if (!res.writableEnded) res.end();
            })
            .pipe(res, { end: true });

    } catch (err) {
        console.error("API Crash:", err);
        if (!res.headersSent) {
            res.status(500).json({ error: "API Crashed", details: err.message });
        } else {
            res.end(); 
        }
    }
};
