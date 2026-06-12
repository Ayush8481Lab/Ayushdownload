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

        const cleanStr = (str) => String(str).replace(/[=;#\\\n]/g, "").trim();
        const songTitle = cleanStr(title || tittle || 'Unknown Title');
        const songArtist = cleanStr(artist || 'Unknown Artist');
        const songAlbum = cleanStr(album || 'Unknown Album');
        
        const outputFormat = 'mp3'; 
        const safeFileName = songTitle.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/ /g, "_") || "audio_download";

        let targetBitrate = '320k'; 
        const qualityMatch = url.match(/\/(\d+)\.mp4/);
        if (qualityMatch && qualityMatch[1]) {
            targetBitrate = `${qualityMatch[1]}k`; 
        }

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
            id3Tags.unsynchronisedLyrics = {
                language: 'eng',
                text: rawText
            };
        }

        const id3HeaderBuffer = NodeID3.create(id3Tags);

        // SPEED FIX: Explicitly tell Vercel to use Chunked Transfer to prevent buffering
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}.${outputFormat}"`);
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Transfer-Encoding', 'chunked'); 

        // Send ID3 tags instantly to start the browser download immediately
        res.write(id3HeaderBuffer);

        ffmpeg(url)
            .inputOptions([
                // BANDWIDTH MULTIPLIER: Reuse the same HTTP connection for all M3U8 chunks
                // This eliminates the SSL handshake delay between every single audio segment!
                '-http_persistent 1', 
                
                '-reconnect 1',
                '-reconnect_streamed 1',
                '-reconnect_delay_max 2'
            ])
            .outputOptions([
                '-vn',                   
                '-f', 'mp3',             
                '-c:a', 'libmp3lame',    
                '-b:a', targetBitrate,   
                
                // SPEED OPTIMIZATION: LAME's fastest CPU algorithm. Uses almost zero CPU.
                '-compression_level', '0', 
                
                '-map_metadata', '-1',   
                '-threads', '0'
            ])
            .on('error', (err) => {
                console.error('FFmpeg Error:', err.message);
                if (!res.writableEnded) res.end();
            })
            // Pipe output to the user at maximum available network speed
            .pipe(res, { end: true });

    } catch (err) {
        if (!res.headersSent) {
            res.status(500).json({ error: "API Crashed", details: err.message });
        } else {
            res.end(); 
        }
    }
};
