const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const crypto = require('crypto');

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

module.exports = async (req, res) => {
    let command;
    let hasCover = false;
    const coverId = crypto.randomBytes(4).toString('hex');
    const coverPath = `/tmp/cover_${coverId}.jpg`;

    const cleanup = () => {
        if (hasCover && fs.existsSync(coverPath)) {
            try { fs.unlinkSync(coverPath); } catch (e) {}
        }
        if (command) {
            try { command.kill('SIGKILL'); } catch (e) {}
        }
    };

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

        // CRITICAL FIX: Appending Date.now() bypasses Android's aggressive "No Lyrics" database cache!
        const baseName = songTitle.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/ /g, "_") || "audio";
        const safeFileName = `${baseName}_${Date.now()}`;

        let targetBitrate = '320k'; 
        const qualityMatch = url.match(/\/(\d+)\.mp4/);
        if (qualityMatch && qualityMatch[1]) {
            targetBitrate = `${qualityMatch[1]}k`; 
        }

        // --- PARALLEL NETWORK REQUESTS (WITH TIMEOUTS) ---
        const fetchTasks = [];
        let imageBuffer = null;
        let lyricsData = null;

        if (imageUrl) {
            if (!imageUrl.startsWith('http')) imageUrl = 'https://' + imageUrl;
            fetchTasks.push(
                fetch(imageUrl, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(4000) })
                    .then(async imgRes => {
                        if (imgRes.ok) imageBuffer = Buffer.from(await imgRes.arrayBuffer());
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

        // --- 1. BUILD STRICT LRC TEXT ---
        let lrcTextVal = '';
        if (lyricsData && lyricsData.lines && lyricsData.lines.length > 0) {
            lrcTextVal += `[ar:${songArtist}]\n`;
            lrcTextVal += `[al:${songAlbum}]\n`;
            lrcTextVal += `[ti:${songTitle}]\n`;
            lrcTextVal += `[au:${songArtist}]\n`;

            const lastLine = lyricsData.lines[lyricsData.lines.length - 1];
            if (lastLine && lastLine.timeTag) {
                const timeMatch = lastLine.timeTag.match(/(\d{2}:\d{2})/);
                if (timeMatch) lrcTextVal += `[length:${timeMatch[1]}]\n`;
            }
            lrcTextVal += `\n`;
            
            lrcTextVal += lyricsData.lines.map(l => {
                const time = l.timeTag ? `[${l.timeTag}]` : '[00:00.00]';
                const words = l.words ? l.words.trim() : ''; 
                return `${time}${words || ' '}`; // Blank space stops parsers from dying on empty instrumental lines
            }).join('\n');
        }

        if (imageBuffer) {
            fs.writeFileSync(coverPath, imageBuffer);
            hasCover = true;
        }

        // --- INSTANT STREAMING ---
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}.${outputFormat}"`);
        res.setHeader('Content-Type', 'audio/mpeg');

        res.on('finish', cleanup);
        res.on('close', cleanup);

        // --- 2. PURE FFMPEG METADATA PIPELINE ---
        command = ffmpeg(url)
            .inputOptions([
                '-allowed_extensions', 'ALL',
                '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
                '-headers', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\r\n',
                '-reconnect', '1',
                '-reconnect_streamed', '1',
                '-reconnect_delay_max', '5'
            ]);

        const outputOptions = [
            '-f', 'mp3',             
            '-c:a', 'libmp3lame',    
            '-b:a', targetBitrate,   
            '-map_metadata', '-1',    // Strip raw M3U8 garbage tags
            '-id3v2_version', '3',    // CRITICAL: ID3v2.3 is the ONLY version perfectly supported by Android 
            '-metadata', `title=${songTitle}`,
            '-metadata', `artist=${songArtist}`,
            '-metadata', `album=${songAlbum}`,
            '-metadata', `album_artist=${songArtist}` // Album Artist is often required by Vivo Music
        ];

        // MUX IN THE COVER ART NATIVELY
        if (hasCover) {
            command.input(coverPath);
            outputOptions.push(
                '-map', '0:a:0',
                '-map', '1:v:0',
                '-c:v', 'mjpeg',
                '-disposition:v', 'attached_pic',
                '-metadata:s:v', 'title=Album cover',
                '-metadata:s:v', 'comment=Cover (front)'
            );
        } else {
            outputOptions.push('-map', '0:a:0', '-vn');
        }

        // MUX IN THE LYRICS NATIVELY
        if (lrcTextVal) {
            // Standard USLT mapping (Works in Mi Music, Samsung, standard players)
            outputOptions.push('-metadata', `lyrics=${lrcTextVal}`);
            // Secret fallback for Vivo/Oppo Music quirks
            outputOptions.push('-metadata', `TXXX:LYRICS=${lrcTextVal}`);
        }

        outputOptions.push('-threads', '1');

        command
            .outputOptions(outputOptions)
            .on('error', (err) => {
                console.error('FFmpeg Error:', err.message);
                cleanup();
                if (!res.writableEnded) res.end();
            })
            .pipe(res, { end: true });

    } catch (err) {
        console.error("API Crash:", err);
        cleanup();
        if (!res.headersSent) {
            res.status(500).json({ error: "API Crashed", details: err.message });
        } else {
            res.end(); 
        }
    }
};
