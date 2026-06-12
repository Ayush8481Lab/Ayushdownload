const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const NodeID3 = require('node-id3');

// VERCEL HACK: Copy FFmpeg to /tmp and give it execute permissions
const tmpFfmpegPath = '/tmp/ffmpeg';

try {
    if (!fs.existsSync(tmpFfmpegPath)) {
        fs.copyFileSync(ffmpegPath, tmpFfmpegPath);
        fs.chmodSync(tmpFfmpegPath, 0o755); 
    }
    ffmpeg.setFfmpegPath(tmpFfmpegPath);
} catch (error) {
    console.error("Failed to setup FFmpeg in /tmp:", error);
}

module.exports = async (req, res) => {
    try {
        let { url, format, imageUrl, title, tittle, artist, album, trackid } = req.query;

        if (!url) return res.status(400).json({ error: "Missing M3U8 url parameter" });
        if (!url.startsWith('http')) url = 'https://' + url;

        // Clean out any special characters
        const cleanStr = (str) => String(str).replace(/[=;#\\\n]/g, "").trim();
        const songTitle = cleanStr(title || tittle || 'Unknown Title');
        const songArtist = cleanStr(artist || 'Unknown Artist');
        const songAlbum = cleanStr(album || 'Unknown Album');
        
        // CRITICAL FIX: Add a unique timestamp to the filename!
        // Android caches broken lyrics. This forces Android to scan the new lyrics perfectly.
        const outputFormat = 'mp3'; 
        const baseName = songTitle.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/ /g, "_") || "audio";
        const safeFileName = `${baseName}_${Date.now()}`;

        // DYNAMIC QUALITY EXTRACTOR
        let targetBitrate = '320k'; 
        const qualityMatch = url.match(/\/(\d+)\.mp4/);
        if (qualityMatch && qualityMatch[1]) {
            targetBitrate = `${qualityMatch[1]}k`; 
        }

        // --- FETCH IMAGES & LYRICS ---
        const fetchTasks = [];
        let imageBuffer = null;
        let imageMime = 'image/jpeg';
        let lyricsData = null;

        if (imageUrl) {
            if (!imageUrl.startsWith('http')) imageUrl = 'https://' + imageUrl;
            fetchTasks.push(
                fetch(imageUrl, { headers: { "User-Agent": "Mozilla/5.0" } })
                    .then(async imgRes => {
                        if (imgRes.ok) {
                            const contentType = imgRes.headers.get('content-type') || '';
                            if (contentType.includes('webp')) imageMime = 'image/webp';
                            else if (contentType.includes('png')) imageMime = 'image/png';
                            
                            imageBuffer = Buffer.from(await imgRes.arrayBuffer());
                        }
                    }).catch(e => console.error("Image fetch failed", e))
            );
        }

        if (trackid) {
            const lyricsUrl = `https://lyr-nine.vercel.app/api/lyrics?url=https://open.spotify.com/track/${trackid}&format=lrc`;
            fetchTasks.push(
                fetch(lyricsUrl)
                    .then(async lyrRes => {
                        if (lyrRes.ok) lyricsData = await lyrRes.json();
                    }).catch(e => console.error("Lyrics fetch failed", e))
            );
        }

        await Promise.all(fetchTasks);

        // --- ID3 CONSTRUCTION ---
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

        // ==========================================
        // 🔥 MI MUSIC LYRICS ENGINE 🔥
        // ==========================================
        if (lyricsData && lyricsData.lines && lyricsData.lines.length > 0) {
            
            // Build the PERFECT standard LRC script with \r\n line breaks
            const lrcLines = [];
            lrcLines.push(`[ti:${songTitle}]`);
            lrcLines.push(`[ar:${songArtist}]`);
            lrcLines.push(`[al:${songAlbum}]`);
            
            lyricsData.lines.forEach(l => {
                const time = l.timeTag ? `[${l.timeTag}]` : '[00:00.00]';
                const words = l.words ? l.words.trim() : '♪'; // Add musical note to keep parser active
                lrcLines.push(`${time}${words}`);
            });

            const lrcText = lrcLines.join('\r\n');

            // 1. Primary Android LRC location (Using 'eng' standard code)
            id3Tags.unsynchronisedLyrics = {
                language: 'eng', 
                shortText: '',
                text: lrcText
            };

            // 2. Secret Xiaomi/Huawei fallback frame
            id3Tags.userDefinedText = [{
                description: 'LYRICS',
                value: lrcText
            }];

            // NOTE: We INTENTIONALLY deleted the SYLT (synchronisedLyrics) frame! 
            // It was causing Mi Music to crash entirely.
        }

        // Generate buffer instantly
        const id3HeaderBuffer = NodeID3.create(id3Tags);

        // --- INSTANT STREAMING ---
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}.${outputFormat}"`);
        res.setHeader('Content-Type', 'audio/mpeg');

        // Send perfectly crafted ID3 tag first
        res.write(id3HeaderBuffer);

        // Stream FFmpeg Audio bytes safely
        ffmpeg(url)
            .outputOptions([
                '-vn',                   
                '-f', 'mp3',             
                '-c:a', 'libmp3lame',    
                '-b:a', targetBitrate,   
                '-map_metadata', '-1',   
                '-write_id3v2', '0',     // 🚨 CRITICAL FIX: Stops FFmpeg from generating a second, empty ID3 tag that ruins your lyrics!
                '-threads', '0'          
            ])
            .on('error', (err) => {
                console.error('FFmpeg Error:', err.message);
                if (!res.writableEnded) res.end();
            })
            .pipe(res, { end: true });

    } catch (err) {
        if (!res.headersSent) {
            res.status(500).json({ error: "API Crashed", details: err.message });
        } else {
            res.end(); 
        }
    }
};
