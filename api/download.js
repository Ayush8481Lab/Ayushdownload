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

        // Clean strings
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

        // --- FETCH IMAGE & LYRICS CONCURRENTLY ---
        const fetchTasks = [];
        let imageBuffer = null;
        let lyricsData = null;

        if (imageUrl) {
            if (!imageUrl.startsWith('http')) imageUrl = 'https://' + imageUrl;
            fetchTasks.push(
                fetch(imageUrl, { headers: { "User-Agent": "Mozilla/5.0" } })
                    .then(async imgRes => {
                        if (imgRes.ok) {
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

        // --- PREPARE STRICT LRC TEXT FORMAT ---
        let lrcText = null;
        if (lyricsData && Array.isArray(lyricsData.lines) && lyricsData.lines.length > 0) {
            const lrcLines = [];
            
            // Mi Music requires standard headers inside the text
            lrcLines.push(`[ti:${songTitle}]`);
            lrcLines.push(`[ar:${songArtist}]`);
            lrcLines.push(`[al:${songAlbum}]`);
            lrcLines.push(`[by:AudioAPI]`);

            // Map timestamps (Using \r\n for maximum LRC parser compatibility)
            lyricsData.lines.forEach(l => {
                const time = l.timeTag || '00:00.00';
                const text = l.words || '♪'; // Fills musical gaps so parser doesn't break
                lrcLines.push(`[${time}]${text}`);
            });

            lrcText = lrcLines.join('\r\n');
        }

        // --- HANDLE IMAGE FILE FOR FFMPEG ---
        const coverId = crypto.randomBytes(8).toString('hex');
        const coverPath = `/tmp/cover_${coverId}.jpg`;
        let hasCover = false;

        if (imageBuffer) {
            // Write image to Vercel's fast /tmp memory to allow FFmpeg to use it as an input stream
            fs.writeFileSync(coverPath, imageBuffer);
            hasCover = true;
        }

        // Clean up function to delete image when stream is done
        const cleanup = () => {
            if (hasCover && fs.existsSync(coverPath)) {
                try { fs.unlinkSync(coverPath); } catch (e) {}
                hasCover = false;
            }
        };

        // --- INSTANT STREAMING HEADERS ---
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}.${outputFormat}"`);
        res.setHeader('Content-Type', 'audio/mpeg');

        // Attach listeners to clean up temporary Vercel files
        res.on('finish', cleanup);
        res.on('close', cleanup);

        // --- FFMPEG METADATA & STREAMING ---
        const command = ffmpeg();
        command.input(url);

        const outputOptions = [
            '-f', 'mp3',
            '-c:a', 'libmp3lame',
            '-b:a', targetBitrate,
            '-id3v2_version', '4',                // CRITICAL FIX: Forces UTF-8 Encoding (Fixes Android OEM Sync Bugs)
            '-metadata', `title=${songTitle}`,
            '-metadata', `artist=${songArtist}`,
            '-metadata', `album=${songAlbum}`
        ];

        // Inject the perfectly formatted LRC string to the ID3v2 USLT (Unsynchronized Lyrics) frame
        if (lrcText) {
            outputOptions.push('-metadata', `lyrics=${lrcText}`);
        }

        // Process Cover Image properly
        if (hasCover) {
            command.input(coverPath);
            outputOptions.push(
                '-map', '0:a',                        // Map Audio
                '-map', '1:v',                        // Map Image
                '-c:v', 'mjpeg',                      // Auto-convert WEBP/PNG to JPEG
                '-disposition:v', 'attached_pic',     // Set as official Album Art
                '-metadata:s:v', 'title=Album cover',
                '-metadata:s:v', 'comment=Cover (front)'
            );
        } else {
            outputOptions.push('-map', '0:a', '-vn');
        }

        outputOptions.push('-threads', '0');

        command
            .outputOptions(outputOptions)
            .on('error', (err) => {
                console.error('FFmpeg Error:', err.message);
                cleanup();
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
