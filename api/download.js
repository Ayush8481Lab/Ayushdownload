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

// Helper: Converts time string "01:25.97" into milliseconds (85970) for ID3 Sync
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

        // Clean out any special characters
        const cleanStr = (str) => String(str).replace(/[=;#\\\n]/g, "").trim();
        const songTitle = cleanStr(title || tittle || 'Unknown Title');
        const songArtist = cleanStr(artist || 'Unknown Artist');
        const songAlbum = cleanStr(album || 'Unknown Album');
        
        const outputFormat = 'mp3'; // Force MP3 (ID3 tags only apply to MP3s)
        const safeFileName = songTitle.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/ /g, "_") || "audio_download";

        // DYNAMIC QUALITY EXTRACTOR
        let targetBitrate = '320k'; 
        const qualityMatch = url.match(/\/(\d+)\.mp4/);
        if (qualityMatch && qualityMatch[1]) {
            targetBitrate = `${qualityMatch[1]}k`; 
        }

        // --- OPTIMIZATION 1: PARALLEL NETWORK REQUESTS ---
        const fetchTasks = [];
        let imageBuffer = null;
        let imageMime = 'image/jpeg';
        let lyricsData = null;

        // Task A: Fetch Image
        if (imageUrl) {
            if (!imageUrl.startsWith('http')) imageUrl = 'https://' + imageUrl;
            fetchTasks.push(
                fetch(imageUrl, { headers: { "User-Agent": "Mozilla/5.0" } })
                    .then(async imgRes => {
                        if (imgRes.ok) {
                            const contentType = imgRes.headers.get('content-type') || '';
                            if (contentType.includes('webp')) imageMime = 'image/webp';
                            else if (contentType.includes('png')) imageMime = 'image/png';
                            
                            const arrayBuf = await imgRes.arrayBuffer();
                            imageBuffer = Buffer.from(arrayBuf);
                        }
                    }).catch(e => console.error("Image fetch failed", e))
            );
        }

        // Task B: Fetch Lyrics
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

        // --- OPTIMIZATION 2: IN-MEMORY ID3 CONSTRUCTION ---
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
        // 🔥 THE MI MUSIC PERFECT LYRICS FIX 🔥
        // ==========================================
        if (lyricsData && lyricsData.lines && lyricsData.lines.length > 0) {
            
            // 1. Build the STRICT standard LRC formatted block that Mi Music looks for
            const lrcLines = [];
            lrcLines.push(`[ti:${songTitle}]`);
            lrcLines.push(`[ar:${songArtist}]`);
            lrcLines.push(`[al:${songAlbum}]`);
            
            lyricsData.lines.forEach(l => {
                const time = l.timeTag ? `[${l.timeTag}]` : '[00:00.00]';
                const words = l.words ? l.words : '♪'; // Add note if gap exists so parser doesn't crash
                lrcLines.push(`${time}${words}`);
            });

            const lrcText = lrcLines.join('\n');
            const rawText = lyricsData.lines.map(l => l.words).join('\n');
            
            if (lyricsData.syncType === "LINE_SYNCED") {
                
                // High-End Players (Spotify, Apple Music offline)
                id3Tags.synchronisedLyrics = [{
                    language: 'XXX', // 'XXX' prevents Asian OEM players from rejecting foreign lyrics
                    timeStampFormat: 2,
                    contentType: 1,
                    synchronisedText: lyricsData.lines.map(l => ({
                        text: l.words || '♪',
                        timeStamp: convertTimeTagToMs(l.timeTag)
                    }))
                }];
                
                // Mi Music / Samsung Music Fallback Fix (They scan this frame specifically!)
                id3Tags.unsynchronisedLyrics = {
                    language: 'XXX',
                    shortText: '', // Keep empty
                    text: lrcText  // Contains exact "[00:31.06]Line 1" strings
                };
                
            } else {
                // If API returns no timestamps, pass just words
                id3Tags.unsynchronisedLyrics = {
                    language: 'XXX',
                    shortText: '',
                    text: rawText
                };
            }
        }

        // Create the raw ID3v2 header buffer instantly (ZERO disk I/O)
        const id3HeaderBuffer = NodeID3.create(id3Tags);

        // --- OPTIMIZATION 3: INSTANT STREAMING (YOUR ORIGINAL STABLE PIPELINE) ---
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}.${outputFormat}"`);
        res.setHeader('Content-Type', 'audio/mpeg');

        // Send the complete ID3 Tag Header immediately to prevent Vercel Timeout!
        res.write(id3HeaderBuffer);

        // Run FFmpeg & Pipe purely Raw Audio data exactly like your first working version
        ffmpeg(url)
            .outputOptions([
                '-vn',                   // Skip cover art in FFmpeg (We already injected it in the ID3 Header)
                '-f', 'mp3',             // Force raw MP3 stream out
                '-c:a', 'libmp3lame',    // MP3 encoder
                '-b:a', targetBitrate,   // Quality enforcement
                '-map_metadata', '-1',   // Strip original M3U8 metadata so it doesn't conflict
                '-threads', '0'          // Use all available CPU cores for decoding
            ])
            .on('error', (err) => {
                console.error('FFmpeg Error:', err.message);
                if (!res.writableEnded) res.end();
            })
            // Pipes the audio chunks continuously, automatically closing the connection when done.
            .pipe(res, { end: true });

    } catch (err) {
        if (!res.headersSent) {
            res.status(500).json({ error: "API Crashed", details: err.message });
        } else {
            res.end(); // Fail gracefully if stream already started
        }
    }
};
