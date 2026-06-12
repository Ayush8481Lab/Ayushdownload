const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const crypto = require('crypto');

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
        
        let targetBitrate = '320k'; 
        const qualityMatch = url.match(/\/(\d+)\.mp4/);
        if (qualityMatch && qualityMatch[1]) {
            targetBitrate = `${qualityMatch[1]}k`; 
        }

        // --- FETCH IMAGE & LYRICS CONCURRENTLY ---
        const fetchTasks = [];
        let imageBuffer = null;
        let lyricsData = null;

        if (imageUrl) {
            if (!imageUrl.startsWith('http')) imageUrl = 'https://' + imageUrl;
            fetchTasks.push(
                fetch(imageUrl, { headers: { "User-Agent": "Mozilla/5.0" } })
                    .then(async imgRes => {
                        if (imgRes.ok) imageBuffer = Buffer.from(await imgRes.arrayBuffer());
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

        // --- GENERATE FFMETADATA FILE IN MEMORY ---
        // This completely fixes the string-crashing bugs and properly injects Mi Music Lyrics natively
        let ffmetadata = `;FFMETADATA1\n`;
        
        // Native FFmpeg escaping to prevent multiline crashes
        const escapeMeta = (str) => String(str)
            .replace(/\\/g, '\\\\')
            .replace(/=/g, '\\=')
            .replace(/;/g, '\\;')
            .replace(/#/g, '\\#')
            .replace(/\n/g, '\\n'); // Uses FFmpeg's native newline decoder

        ffmetadata += `title=${escapeMeta(songTitle)}\n`;
        ffmetadata += `artist=${escapeMeta(songArtist)}\n`;
        ffmetadata += `album=${escapeMeta(songAlbum)}\n`;

        if (lyricsData && Array.isArray(lyricsData.lines) && lyricsData.lines.length > 0) {
            if (lyricsData.syncType === "LINE_SYNCED") {
                // Strict Android MediaStore LRC format
                let lrcText = `[ti:${songTitle}]\n[ar:${songArtist}]\n[al:${songAlbum}]\n`;
                lrcText += lyricsData.lines.map(l => `[${l.timeTag || '00:00.00'}]${(l.words || '♪').trim()}`).join('\n');
                
                // Tag A: Standard USLT frame
                ffmetadata += `lyrics=${escapeMeta(lrcText)}\n`;
                // Tag B: Custom TXXX Lyrics frame (Specifically for Xiaomi/KuGou Music)
                ffmetadata += `LYRICS=${escapeMeta(lrcText)}\n`; 
            } else {
                // Unsynced fallback
                const plainText = lyricsData.lines.map(l => (l.words || '').trim()).join('\n');
                ffmetadata += `lyrics=${escapeMeta(plainText)}\n`;
            }
        }

        // Save metadata & cover dynamically to Vercel's fast /tmp storage
        const metaId = crypto.randomBytes(6).toString('hex');
        const metaPath = `/tmp/meta_${metaId}.txt`;
        const coverPath = `/tmp/cover_${metaId}.jpg`;
        
        fs.writeFileSync(metaPath, ffmetadata);

        let hasCover = false;
        if (imageBuffer) {
            fs.writeFileSync(coverPath, imageBuffer);
            hasCover = true;
        }

        // Auto-delete /tmp files when stream completes
        const cleanup = () => {
            try { if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath); } catch(e) {}
            try { if (hasCover && fs.existsSync(coverPath)) fs.unlinkSync(coverPath); } catch(e) {}
        };

        const safeFileName = songTitle.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/ /g, "_") || "audio";

        // --- INSTANT STREAMING ---
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}.mp3"`);
        res.setHeader('Content-Type', 'audio/mpeg');

        res.on('finish', cleanup);
        res.on('close', cleanup);

        // --- FFMPEG PIPELINE ---
        const command = ffmpeg();
        
        command.input(url);         // Input 0: M3U8 Stream
        command.input(metaPath);    // Input 1: Flawless Metadata Tag File
        
        const outputOptions = [
            '-f', 'mp3',
            '-c:a', 'libmp3lame',
            '-b:a', targetBitrate,
            '-map', '0:a',               // Process Audio Stream
            '-map_metadata', '1',        // Map all lyrics & text from Input 1
            '-id3v2_version', '3',       // ID3v2.3 is the ONLY format 100% supported by Mi Music [VITAL]
            '-threads', '0'
        ];

        if (hasCover) {
            command.input(coverPath);    // Input 2: Album Art
            outputOptions.push(
                '-map', '2:v',
                '-c:v', 'mjpeg',
                '-disposition:v', 'attached_pic',
                '-metadata:s:v', 'title=Album cover',
                '-metadata:s:v', 'comment=Cover (front)'
            );
        } else {
            outputOptions.push('-vn');
        }

        command
            .outputOptions(outputOptions)
            .on('error', (err) => {
                console.error('FFmpeg Error:', err.message);
                cleanup();
                if (!res.writableEnded) res.end();
            })
            // Pipes dynamically to user—no Vercel timeout crashes ever again
            .pipe(res, { end: true });

    } catch (err) {
        console.error('API Error:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: "API Crashed", details: err.message });
        } else {
            res.end();
        }
    }
};
