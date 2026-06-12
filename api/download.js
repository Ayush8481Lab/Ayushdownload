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
    console.error("Failed to setup FFmpeg in /tmp, using default path:", error);
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

        // Clean strings strictly so HTTP headers don't break
        const cleanStr = (str) => String(str).replace(/[=;#\\\"\n\r,]/g, "").trim();
        const songTitle = cleanStr(title || tittle || 'Unknown Title');
        const songArtist = cleanStr(artist || 'Unknown Artist');
        const songAlbum = cleanStr(album || 'Unknown Album');
        
        const outputFormat = 'mp3'; 
        const baseName = songTitle.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/ /g, "_") || "audio";
        const safeFileName = `${baseName}_${crypto.randomBytes(2).toString('hex')}`;

        let targetBitrate = '320k'; 
        const qualityMatch = url.match(/\/(\d+)\.mp4/);
        if (qualityMatch && qualityMatch[1]) {
            targetBitrate = `${qualityMatch[1]}k`; 
        }

        // --- FETCH DATA CONCURRENTLY WITH TIMEOUTS ---
        const fetchTasks = [];
        let imageBuffer = null;
        let lrcText = ''; 

        // 1. Fetch Cover Art (Max 4 seconds wait to prevent Vercel Timeout)
        if (imageUrl) {
            if (!imageUrl.startsWith('http')) imageUrl = 'https://' + imageUrl;
            fetchTasks.push(
                fetch(imageUrl, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(4000) })
                    .then(async imgRes => {
                        if (imgRes.ok) imageBuffer = Buffer.from(await imgRes.arrayBuffer());
                    }).catch(e => console.error("Image fetch failed", e.message))
            );
        }

        // 2. Fetch Lyrics (Max 4 seconds wait to prevent Vercel Timeout)
        if (trackid) {
            const lyricsUrl = `https://lyr-nine.vercel.app/api/lyrics?url=https://open.spotify.com/track/${trackid}&format=lrc`;
            fetchTasks.push(
                fetch(lyricsUrl, { signal: AbortSignal.timeout(4000) })
                    .then(async lyrRes => {
                        if (!lyrRes.ok) return;
                        const textData = await lyrRes.text();
                        
                        // Fix: Ensure the API didn't return an HTML error page
                        if (textData.trim().startsWith('<') || textData.includes('<!DOCTYPE html>')) return;
                        
                        try {
                            const json = JSON.parse(textData);
                            if (json && json.lines && json.lines.length > 0) {
                                lrcText = `[ti:${songTitle}]\n[ar:${songArtist}]\n[al:${songAlbum}]\n`;
                                lrcText += json.lines.map(l => {
                                    const time = l.timeTag ? `[${l.timeTag}]` : '[00:00.00]';
                                    const words = l.words ? l.words.trim() : ' ';
                                    return `${time}${words}`;
                                }).join('\n');
                            } else if (json && json.lyrics) {
                                lrcText = json.lyrics; 
                            }
                        } catch (err) {
                            lrcText = textData; // Standard LRC text fallback
                        }
                    }).catch(e => console.error("Lyrics fetch failed", e.message))
            );
        }

        // Fix: Use allSettled so if Lyrics API crashes, the song STILL downloads!
        await Promise.allSettled(fetchTasks);

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

        // --- FFMPEG PACKAGER PIPELINE ---
        command = ffmpeg();
        command.input(url);
        
        // CRITICAL FIX: Add Whitelist and Network rules so M3U8 doesn't crash FFmpeg
        command.inputOptions([
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
            '-b:a', targetBitrate, // CBR mode automatically handled by lame
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
                '-map', '0:a:0', // CRITICAL FIX: Only pick the primary audio stream
                '-map', '1:v:0', // Only pick the image stream
                '-c:v', 'mjpeg',
                '-disposition:v', 'attached_pic',
                '-metadata:s:v', 'title=Album cover',
                '-metadata:s:v', 'comment=Cover (front)'
            );
        } else {
            outputOptions.push('-map', '0:a:0', '-vn');
        }

        // 3. SECURE COMPATIBILITY 
        outputOptions.push('-id3v2_version', '3'); 
        outputOptions.push('-threads', '1'); // Fixes Vercel Free-tier CPU throttling crash

        command
            .outputOptions(outputOptions)
            .on('error', (err) => {
                console.error('FFmpeg Error:', err.message);
                cleanup();
                if (!res.writableEnded) res.end();
            })
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
