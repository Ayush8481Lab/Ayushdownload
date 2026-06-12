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
        
        const outputFormat = 'mp3'; 
        const baseName = songTitle.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/ /g, "_") || "audio";
        // Force Android to scan the file as a brand new song (defeats cached "No lyrics" bugs)
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
        let lyricsData = null;

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
                        if (lyrRes.ok) lyricsData = await lyrRes.json();
                    }).catch(e => console.error("Lyrics fetch failed", e))
            );
        }

        await Promise.all(fetchTasks);

        // --- PREPARE IMAGE ATTACHMENT ---
        const coverId = crypto.randomBytes(4).toString('hex');
        const coverPath = `/tmp/cover_${coverId}.jpg`;
        let hasCover = false;

        if (imageBuffer) {
            fs.writeFileSync(coverPath, imageBuffer);
            hasCover = true;
        }

        const cleanup = () => {
            if (hasCover && fs.existsSync(coverPath)) {
                try { fs.unlinkSync(coverPath); } catch (e) {}
            }
        };

        // --- PREPARE LRC FORMAT ATTACHMENT ---
        let lrcText = '';
        if (lyricsData && lyricsData.lines && lyricsData.lines.length > 0) {
            // Strictly formatted LRC layout
            lrcText += `[ti:${songTitle}]\n[ar:${songArtist}]\n[al:${songAlbum}]\n`;
            lrcText += lyricsData.lines.map(l => {
                const time = l.timeTag ? `[${l.timeTag}]` : '[00:00.00]';
                const words = l.words ? l.words.trim() : ' '; // Blank space prevents Android parser from crashing
                return `${time}${words}`;
            }).join('\n');
        }

        // --- INSTANT STREAMING ---
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}.${outputFormat}"`);
        res.setHeader('Content-Type', 'audio/mpeg');

        res.on('finish', cleanup);
        res.on('close', cleanup);

        // --- FFMPEG PACKAGER PIPELINE ---
        const command = ffmpeg();
        command.input(url);
        
        const outputOptions = [
            '-f', 'mp3',
            '-c:a', 'libmp3lame',
            '-b:a', targetBitrate,
            '-minrate', targetBitrate, // CBR mode makes Mi Music timeline mapping flawless
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
        if (!res.headersSent) {
            res.status(500).json({ error: "API Crashed", details: err.message });
        } else {
            res.end();
        }
    }
};
