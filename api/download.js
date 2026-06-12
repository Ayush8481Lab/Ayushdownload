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
        const safeFileName = songTitle.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/ /g, "_") || "audio_download";

        let targetBitrate = '320k'; 
        const qualityMatch = url.match(/\/(\d+)\.mp4/);
        if (qualityMatch && qualityMatch[1]) {
            targetBitrate = `${qualityMatch[1]}k`; 
        }

        // --- OPTIMIZATION 1: PARALLEL NETWORK REQUESTS (WITH TIMEOUTS) ---
        const fetchTasks = [];
        let imageBuffer = null;
        let imageMime = 'image/jpeg';
        let lyricsData = null;

        // Task A: Fetch Image (Max 4s timeout to avoid Vercel crash)
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

        // Task B: Fetch Lyrics (Max 4s timeout to avoid Vercel crash)
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

        // --- OPTIMIZATION 2: BUILD STRICT LRC FORMAT & IN-MEMORY ID3 ---
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
            // 1. BUILD THE EXACT LRC METADATA STRING YOU REQUESTED
            let lrcTextVal = `[id: ${trackid || crypto.randomBytes(4).toString('hex')}]\n`;
            lrcTextVal += `[ar: ${songArtist}]\n`;
            lrcTextVal += `[al: ${songAlbum}]\n`;
            lrcTextVal += `[ti: ${songTitle}]\n`;
            lrcTextVal += `[au: ${songArtist}]\n`;

            // Calculate length from the very last lyric timestamp
            const lastLine = lyricsData.lines[lyricsData.lines.length - 1];
            if (lastLine && lastLine.timeTag) {
                const timeMatch = lastLine.timeTag.match(/(\d{2}:\d{2})/);
                if (timeMatch) lrcTextVal += `[length: ${timeMatch[1]}]\n`;
            }
            lrcTextVal += `\n`; // Empty line before lyrics start
            
            // 2. APPEND THE [Time]line SYNC TAGS
            lrcTextVal += lyricsData.lines.map(l => {
                const time = l.timeTag ? `[${l.timeTag}]` : '[00:00.00]';
                const words = l.words || ' '; // Prevent empty line crash
                return `${time}${words}`;
            }).join('\n');

            // 3. EMBED THE STRICT STRING INTO THE MP3
            id3Tags.unsynchronisedLyrics = {
                language: 'eng',
                text: lrcTextVal
            };

            // 4. ALSO EMBED NATIVE BINARY SYNC (Bonus player compatibility)
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

        // Create the raw ID3v2 header buffer instantly
        const id3HeaderBuffer = NodeID3.create(id3Tags);

        // --- OPTIMIZATION 3: INSTANT STREAMING ---
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}.${outputFormat}"`);
        res.setHeader('Content-Type', 'audio/mpeg');

        // Send the ID3 Tag Header immediately!
        res.write(id3HeaderBuffer);

        // --- CRITICAL FIX: FFMPEG PIPELINE ---
        ffmpeg(url)
            // THESE INPUT OPTIONS ARE REQUIRED TO STOP M3U8 DOWNLOADS FROM FAILING
            .inputOptions([
                '-allowed_extensions', 'ALL',
                '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
                '-headers', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\r\n',
                '-reconnect', '1',
                '-reconnect_streamed', '1',
                '-reconnect_delay_max', '5'
            ])
            .outputOptions([
                '-vn',                   // Skip cover art in FFmpeg (We already injected it in ID3)
                '-f', 'mp3',             // Force raw MP3 stream out
                '-c:a', 'libmp3lame',    
                '-b:a', targetBitrate,   
                '-map_metadata', '-1',   // Strip original M3U8 metadata
                '-threads', '1'          // 1 is much safer for Vercel Free-Tier memory limits
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
