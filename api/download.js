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
        
        const outputFormat = 'mp3'; 
        const safeFileName = songTitle.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/ /g, "_") || "audio_download";

        // DYNAMIC QUALITY EXTRACTOR
        let targetBitrate = '320k'; 
        const qualityMatch = url.match(/\/(\d+)\.mp4/);
        if (qualityMatch && qualityMatch[1]) {
            targetBitrate = `${qualityMatch[1]}k`; 
        }

        // --- FETCH DATA CONCURRENTLY ---
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
                            
                            const arrayBuf = await imgRes.arrayBuffer();
                            imageBuffer = Buffer.from(arrayBuf);
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

        // --- IN-MEMORY ID3 CONSTRUCTION ---
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

        // --- MI MUSIC LYRICS FIX (Done entirely in NodeJS, no FFmpeg crashing) ---
        if (lyricsData && Array.isArray(lyricsData.lines) && lyricsData.lines.length > 0) {
            
            // Mi Music natively scans for standard LRC headers and `\r\n` line endings
            let lrcText = `[ti:${songTitle}]\r\n[ar:${songArtist}]\r\n[al:${songAlbum}]\r\n`;
            
            // Map the exact timestamps
            lrcText += lyricsData.lines.map(l => {
                const time = l.timeTag || '00:00.00';
                const text = l.words || '♪'; // Fills instrumental gaps so the parser doesn't break
                return `[${time}]${text}`;
            }).join('\r\n');

            // 1. Inject into standard USLT (Unsynchronised Lyrics)
            id3Tags.unsynchronisedLyrics = {
                language: 'eng',
                text: lrcText
            };

            // 2. Inject into TXXX (User Defined Text) frame for specific Chinese Android Players
            id3Tags.userDefinedText = [{
                description: 'LYRICS',
                value: lrcText
            }];
        }

        // Create the raw ID3v2 header buffer instantly 
        const id3HeaderBuffer = NodeID3.create(id3Tags);

        // --- INSTANT STREAMING ---
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}.${outputFormat}"`);
        res.setHeader('Content-Type', 'audio/mpeg');

        // Send the perfectly formatted node-id3 buffer first
        res.write(id3HeaderBuffer);

        // Run FFmpeg just to handle the raw audio decoding (Exactly as your original working code)
        ffmpeg(url)
            .outputOptions([
                '-vn',                   // Skip cover art in FFmpeg (Handled by ID3)
                '-f', 'mp3',             // Force raw MP3 stream out
                '-c:a', 'libmp3lame',    // MP3 encoder
                '-b:a', targetBitrate,   // Quality enforcement
                '-map_metadata', '-1',   // Prevent FFmpeg from overwriting our ID3 metadata
                '-threads', '0'          // Multi-threading
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
