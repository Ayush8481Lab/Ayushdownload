const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const crypto = require('crypto');

// VERCEL HACK: Safely setup FFmpeg path with a fallback
const tmpFfmpegPath = '/tmp/ffmpeg';
try {
    if (!fs.existsSync(tmpFfmpegPath)) {
        fs.copyFileSync(ffmpegPath, tmpFfmpegPath);
        fs.chmodSync(tmpFfmpegPath, 0o755);
    }
    ffmpeg.setFfmpegPath(tmpFfmpegPath);
} catch (error) {
    console.error("Failed to setup FFmpeg in /tmp, using default node_modules path:", error);
    ffmpeg.setFfmpegPath(ffmpegPath); // Fallback if /tmp copy fails
}

module.exports = async (req, res) => {
    let command; // Reference to kill ffmpeg if the user cancels download
    let hasCover = false;
    const coverId = crypto.randomBytes(4).toString('hex');
    const coverPath = `/tmp/cover_${coverId}.jpg`;

    const cleanup = () => {
        if (hasCover && fs.existsSync(coverPath)) {
            try { fs.unlinkSync(coverPath); } catch (e) {}
        }
        if (command) {
            try { command.kill('SIGKILL'); } catch (e) {} // Stop zombie processes saving Vercel memory
        }
    };

    try {
        let { url, format, imageUrl, title, tittle, artist, album, trackid } = req.query;

        if (!url) return res.status(400).json({ error: "Missing M3U8 url parameter" });
        if (!url.startsWith('http')) url = 'https://' + url;

        // FIX: Removed '"' and ',' from names to prevent HTTP Header crashes
        const cleanStr = (str) => String(str).replace(/[=;#\\\"\n\r,]/g, "").trim();
        const songTitle = cleanStr(title || tittle || 'Unknown Title');
        const songArtist = cleanStr(artist || 'Unknown Artist');
        const songAlbum = cleanStr(album || 'Unknown Album');
        
        const outputFormat = 'mp3'; 
        const baseName = songTitle.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/ /g, "_") || "audio";
        const safeFileName = `${baseName}_${crypto.randomBytes(2).toString('hex')}`;

        // DYNAMIC QUALITY EXTRACTOR
        let targetBitrate = '320k'; 
        const qualityMatch = url.match(/\/(\d+)\.mp4/);
        if (qualityMatch && qualityMatch[1]) {
            targetBitrate = `${qualityMatch[1]}k`; 
        }

        // --- FETCH DATA CONCURRENTLY ---
        const fetchTasks = [];
        let imageBuffer = null;
        let lrcText = ''; // Defined properly up here

        // Fetch Cover Art
        if (imageUrl) {
            if (!imageUrl.startsWith('http')) imageUrl = 'https://' + imageUrl;
            fetchTasks.push(
                fetch(imageUrl, { headers: { "User-Agent": "Mozilla/5.0" } })
                    .then(async imgRes => {
                        if (imgRes.ok) imageBuffer = Buffer.from(await imgRes.arrayBuffer());
                    }).catch(e => console.error("Image fetch failed", e))
            );
        }

        // Fetch Lyrics
        if (trackid) {
            const lyricsUrl = `https://lyr-nine.vercel.app/api/lyrics?url=https://open.spotify.com/track/${trackid}&format=lrc`;
            fetchTasks.push(
                fetch(lyricsUrl)
                    .then(async lyrRes => {
                        if (!lyrRes.ok) return;
                        const textData = await lyrRes.text();
                        
                        try {
                            // First, try parsing it as JSON
                            const json = JSON.parse(textData);
                            if (json && json.lines && json.lines.length > 0) {
                                lrcText = `[ti:${songTitle}]\n[ar:${songArtist}]\n[al:${songAlbum}]\n`;
                                lrcText += json.lines.map(l => {
                                    const time = l.timeTag ? `[${l.timeTag}]` : '[00:00.00]';
                                    const words = l.words ? l.words.trim() : ' ';
                                    return `${time}${words}`;
                                }).join('\n');
                            } else if (json && json.lyrics) {
                                lrcText = json.lyrics; // Fallback for simple lyrics JSON
                            }
                        } catch (err) {
                            // FIX: If JSON parse fails, the API actually sent raw LRC plain-text! 
                            lrcText = textData;
                        }
                    }).catch(e => console.error("Lyrics fetch failed", e))
            );
        }

        await Promise.all(fetchTasks);

        // --- PREPARE IMAGE ATTACHMENT ---
        if (imageBuffer) {
            fs.writeFileSync(coverPath, imageBuffer);
            hasCover = true;
        }

        // --- INSTANT STREAMING ---
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}.${outputFormat}"`);
        res.setHeader('Content-Type', 'audio/mpeg');

        res.on('finish', cleanup);
        res.on('close', cleanup); // Kills FFmpeg if user pauses/cancels download

        // --- FFMPEG PACKAGER PIPELINE ---
        command = ffmpeg();
        command.input(url);
        
        // FIX: Add network stability flags to stop the M3U8 download from failing
        command.inputOptions([
            '-headers', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\r\n',
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '5'
        ]);

        const outputOptions = [
            '-f', 'mp3',
            '-c:a', 'libmp3lame',
            '-b:a', targetBitrate,
            '-minrate', targetBitrate, 
            '-maxrate', targetBitrate, 
            '-metadata', `title=${songTitle}`,
            '-metadata', `artist=${songArtist}`,
            '-metadata', `album=${songAlbum}`
        ];

        // 1. EMBED LRC JUST LIKE A SEPARATE FILE 
        if (lrcText) {
            outputOptions.push('-metadata', `lyrics=${lrcText}`);
        }

        // 2. EMBED COVER ART
        if (hasCover) {
            command.input(coverPath);
            outputOptions.push(
                '-map', '0:a',
                '-map', '1:v',
                '-c:v', 'mjpeg',
                '-disposition:v', 'attached_pic',
                '-metadata:s:v', 'title=Album cover',
                '-metadata:s:v', 'comment=Cover (front)'
            );
        } else {
            outputOptions.push('-map', '0:a', '-vn');
        }

        // 3. SECURE COMPATIBILITY 
        outputOptions.push('-id3v2_version', '3'); // ID3v2.3 is what Android fully expects
        outputOptions.push('-threads', '0');

        command
            .outputOptions(outputOptions)
            .on('error', (err) => {
                console.error('FFmpeg Error:', err.message);
                cleanup();
                if (!res.writableEnded) res.end();
            })
            // Stream continuously (NO VERCEL CRASHES)
            .pipe(res, { end: true });

    } catch (err) {
        console.error('API Error:', err);
        cleanup();
        if (!res.headersSent) {
            res.status(500).json({ error: "API Crashed", details: err.message });
        } else {
            res.end();
        }
    }
};
