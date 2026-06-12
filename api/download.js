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

// Helper: Converts time string "01:25.97" into milliseconds for ID3 SYLT Sync
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

        // STRICT SANITIZATION: Fixes the "Download Failed" HTTP Header crashes
        const songTitle = String(title || tittle || 'Unknown Title').replace(/[^\w\s-]/gi, '').trim();
        const songArtist = String(artist || 'Unknown Artist').replace(/[^\w\s-]/gi, '').trim();
        const songAlbum = String(album || 'Unknown Album').replace(/[^\w\s-]/gi, '').trim();
        
        // Append Date.now() to bypass Mi Music's aggressive "No Lyrics" database caching!
        const safeFileName = `${songTitle.replace(/\s+/g, "_")}_${Date.now()}`;

        let targetBitrate = '320k'; 
        const qualityMatch = url.match(/\/(\d+)\.mp4/);
        if (qualityMatch && qualityMatch[1]) {
            targetBitrate = `${qualityMatch[1]}k`; 
        }

        // --- PARALLEL NETWORK REQUESTS (WITH SAFETY TIMEOUTS) ---
        const fetchTasks = [];
        let imageBuffer = null;
        let imageMime = 'image/jpeg';
        let lyricsData = null;

        if (imageUrl) {
            if (!imageUrl.startsWith('http')) imageUrl = 'https://' + imageUrl;
            fetchTasks.push(
                fetch(imageUrl, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(4500) })
                    .then(async imgRes => {
                        if (imgRes.ok) {
                            const contentType = imgRes.headers.get('content-type') || '';
                            if (contentType.includes('webp')) imageMime = 'image/webp';
                            else if (contentType.includes('png')) imageMime = 'image/png';
                            imageBuffer = Buffer.from(await imgRes.arrayBuffer());
                        }
                    }).catch(() => console.error("Image fetch failed"))
            );
        }

        if (trackid) {
            const lyricsUrl = `https://lyr-nine.vercel.app/api/lyrics?url=https://open.spotify.com/track/${trackid}&format=lrc`;
            fetchTasks.push(
                fetch(lyricsUrl, { signal: AbortSignal.timeout(4500) })
                    .then(async lyrRes => {
                        if (lyrRes.ok) lyricsData = await lyrRes.json();
                    }).catch(() => console.error("Lyrics fetch failed"))
            );
        }

        await Promise.allSettled(fetchTasks);

        // --- 1. BUILD THE ULTIMATE ID3 BUFFER ---
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
                description: 'Cover',
                imageBuffer: imageBuffer
            };
        }

        if (lyricsData && lyricsData.lines && lyricsData.lines.length > 0) {
            // LRC Formatting
            let lrcTextVal = `[ar:${songArtist}]\n[al:${songAlbum}]\n[ti:${songTitle}]\n[au:${songArtist}]\n`;
            const lastLine = lyricsData.lines[lyricsData.lines.length - 1];
            if (lastLine && lastLine.timeTag) {
                const timeMatch = lastLine.timeTag.match(/(\d{2}:\d{2})/);
                if (timeMatch) lrcTextVal += `[length:${timeMatch[1]}]\n`;
            }
            lrcTextVal += `\n`;
            
            lrcTextVal += lyricsData.lines.map(l => {
                const time = l.timeTag ? `[${l.timeTag}]` : '[00:00.00]';
                const words = l.words ? l.words.trim() : ''; 
                return `${time}${words}`;
            }).join('\n');

            // Standard USLT (Mi Music & Samsung requirement)
            id3Tags.unsynchronisedLyrics = {
                language: 'XXX', // "All Languages". Forces Android to not ignore it!
                shortText: '',   // STRICTLY EMPTY for OEM compatibility
                text: lrcTextVal
            };

            // TXXX Fallback (Vivo / Oppo Music requirement)
            id3Tags.userDefinedText = [{
                description: 'LYRICS',
                value: lrcTextVal
            }];

            // Native SYLT Binary Line Sync (Highest compatibility)
            if (lyricsData.syncType === "LINE_SYNCED") {
                id3Tags.synchronisedLyrics = [{
                    language: 'eng',
                    timeStampFormat: 2,
                    contentType: 1,
                    synchronisedText: lyricsData.lines.map(l => ({
                        text: l.words || '',
                        timeStamp: convertTimeTagToMs(l.timeTag)
                    }))
                }];
            }
        }

        // Generate the ID3 Hex Buffer in memory
        const id3HeaderBuffer = NodeID3.create(id3Tags);

        // --- 2. PREPARE HTTP STREAM HEADERS ---
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        const encodedFilename = encodeURIComponent(`${safeFileName}.mp3`);
        res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}.mp3"; filename*=UTF-8''${encodedFilename}`);
        res.setHeader('Content-Type', 'audio/mpeg');

        // IMMEDIATELY SEND THE FLAWLESS ID3 TAGS TO THE CLIENT
        res.write(id3HeaderBuffer);

        // --- 3. STREAM PURE AUDIO FRAMES (THE MAGIC FIX) ---
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
                '-vn',                   // Drop video/art (We already injected the cover via NodeID3)
                '-f', 'mp3',             // MP3 format
                '-c:a', 'libmp3lame',    
                '-b:a', targetBitrate,   
                '-map_metadata', '-1',   // Strip original streaming data
                // 👇 THESE 3 LINES PREVENT FILE CORRUPTION & DOWNLOAD FAILURES 👇
                '-write_xing', '0',      // CRITICAL: Stops the conflicting Xing header
                '-write_id3v2', '0',     // CRITICAL: Stops FFmpeg from overwriting NodeID3
                '-write_id3v1', '0',     // CRITICAL: Removes legacy junk tags
                '-threads', '1'          // Stops Vercel memory crashes
            ])
            .on('error', (err) => {
                console.error('FFmpeg Streaming Error:', err.message);
                if (!res.writableEnded) res.end();
            })
            // Stream continuously
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
