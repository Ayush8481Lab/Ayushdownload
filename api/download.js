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

// Helper: Converts time string "01:25.97" into milliseconds for internal MP3 ID3 Sync
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
        let { url, imageUrl, title, tittle, artist, album, trackid, filetype } = req.query;

        // Clean out special characters that might break metadata
        const cleanStr = (str) => String(str).replace(/[=;#\\\n]/g, "").trim();
        const songTitle = cleanStr(title || tittle || 'Unknown Title');
        const songArtist = cleanStr(artist || 'Unknown Artist');
        const songAlbum = cleanStr(album || 'Unknown Album');
        
        const safeFileName = songTitle.replace(/[/\\:*?<>|]/g, "").trim() || "audio_download";
        const fallbackName = safeFileName.replace(/"/g, "'");
        const encodedName = encodeURIComponent(safeFileName);

        // ==========================================
        // MODE 1: GENERATE & DOWNLOAD .LRC FILE
        // ==========================================
        if (filetype === 'lrc') {
            if (!trackid) return res.status(400).json({ error: "Missing trackid parameter" });

            try {
                const lyricsUrl = `https://lyr-nine.vercel.app/api/lyrics?url=https://open.spotify.com/track/${trackid}&format=lrc`;
                const lyrRes = await fetch(lyricsUrl);
                const lyricsData = await lyrRes.json();

                if (!lyricsData || !lyricsData.lines || lyricsData.lines.length === 0 || lyricsData.syncType !== "LINE_SYNCED") {
                    return res.status(404).send("Synced lyrics not found");
                }

                // Format exactly as requested
                let lrcContent = `[ar:${songArtist}]\n[al:${songAlbum}]\n[ti:${songTitle}]\n[au:${songArtist}]\n[length:00:00]\n`;
                lyricsData.lines.forEach(line => {
                    lrcContent += `[${line.timeTag}]${line.words}\n`;
                });

                // Server-side headers guarantee Android won't rename to .txt or send to Movies folder
                res.setHeader('Content-Disposition', `attachment; filename="${fallbackName}.lrc"; filename*=UTF-8''${encodedName}.lrc`);
                res.setHeader('Content-Type', 'application/octet-stream');
                
                return res.send(lrcContent);
            } catch (e) {
                return res.status(500).send("Failed to generate LRC");
            }
        }


        // ==========================================
        // MODE 2: GENERATE & DOWNLOAD .MP3 FILE
        // ==========================================
        if (!url) return res.status(400).json({ error: "Missing M3U8 url parameter" });
        if (!url.startsWith('http')) url = 'https://' + url;

        let targetBitrate = '320k'; 
        const qualityMatch = url.match(/\/(\d+)\.mp4/);
        if (qualityMatch && qualityMatch[1]) targetBitrate = `${qualityMatch[1]}k`; 

        const outputFormat = 'mp3'; 

        // FETCH IMAGE AND LYRICS IN PARALLEL
        const fetchTasks = [];
        let imageBuffer = null;
        let imageMime = 'image/jpeg';
        let lyricsData = null;

        if (imageUrl) {
            if (!imageUrl.startsWith('http')) imageUrl = 'https://' + imageUrl;
            fetchTasks.push(
                fetch(imageUrl, { headers: { "User-Agent": "Mozilla/5.0" } }).then(async imgRes => {
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
                fetch(lyricsUrl).then(async lyrRes => {
                    if (lyrRes.ok) lyricsData = await lyrRes.json();
                }).catch(e => console.error("Lyrics fetch failed", e))
            );
        }

        await Promise.all(fetchTasks);

        // CREATE ID3 TAGS (Injects lyrics directly into the MP3 file too!)
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

        if (lyricsData && lyricsData.lines && lyricsData.lines.length > 0) {
            const rawText = lyricsData.lines.map(l => l.words).join('\n');
            if (lyricsData.syncType === "LINE_SYNCED") {
                id3Tags.synchronisedLyrics = [{
                    language: 'eng',
                    timeStampFormat: 2,
                    contentType: 1,
                    synchronisedText: lyricsData.lines.map(l => ({
                        text: l.words,
                        timeStamp: convertTimeTagToMs(l.timeTag)
                    }))
                }];
            }
            id3Tags.unsynchronisedLyrics = { language: 'eng', text: rawText };
        }

        const id3HeaderBuffer = NodeID3.create(id3Tags);

        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Content-Disposition', `attachment; filename="${fallbackName}.${outputFormat}"; filename*=UTF-8''${encodedName}.${outputFormat}`);
        res.setHeader('Content-Type', 'audio/mpeg');

        res.write(id3HeaderBuffer);

        ffmpeg(url)
            .outputOptions([
                '-vn',                   
                '-f', 'mp3',             
                '-c:a', 'libmp3lame',    
                '-b:a', targetBitrate,   
                '-map_metadata', '-1',   
                '-threads', '0'          
            ])
            .on('error', (err) => {
                console.error('FFmpeg Error:', err.message);
                if (!res.writableEnded) res.end();
            })
            .pipe(res, { end: true });

    } catch (err) {
        if (!res.headersSent) res.status(500).json({ error: "API Crashed", details: err.message });
        else res.end(); 
    }
};
