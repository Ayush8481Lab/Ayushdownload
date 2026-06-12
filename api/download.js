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

        const cleanStr = (str) => String(str).replace(/[=;#\\\n]/g, "").trim();
        const songTitle = cleanStr(title || tittle || 'Unknown Title');
        const songArtist = cleanStr(artist || 'Unknown Artist');
        const songAlbum = cleanStr(album || 'Unknown Album');
        
        // UNIQUE FILENAME: Defeats Android's aggressive lyrics caching
        const outputFormat = 'mp3'; 
        const baseName = songTitle.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/ /g, "_") || "audio";
        const safeFileName = `${baseName}_${Date.now()}`;

        let targetBitrate = '320k'; 
        const qualityMatch = url.match(/\/(\d+)\.mp4/);
        if (qualityMatch && qualityMatch[1]) {
            targetBitrate = `${qualityMatch[1]}k`; 
        }

        // --- CONCURRENT NETWORK FETCH ---
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
                            imageBuffer = Buffer.from(await imgRes.arrayBuffer());
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

        // --- ID3 & DURATION (TIMELINE) CONSTRUCTION ---
        let durationMs = 180000; // Fallback to 3 minutes
        if (lyricsData && lyricsData.lines && lyricsData.lines.length > 0) {
            // Find the last lyric timestamp and add 15 seconds to estimate Track Length
            const lastLine = lyricsData.lines[lyricsData.lines.length - 1];
            if (lastLine && lastLine.timeTag) {
                durationMs = convertTimeTagToMs(lastLine.timeTag) + 15000;
            }
        }

        const id3Tags = {
            title: songTitle,
            artist: songArtist,
            album: songAlbum,
            performerInfo: songArtist,
            length: durationMs.toString() // CRITICAL: Gives Android the exact timeline so lyrics activate!
        };

        if (imageBuffer) {
            id3Tags.image = {
                mime: imageMime,
                type: { id: 3, name: 'front cover' },
                description: 'Cover Art',
                imageBuffer: imageBuffer
            };
        }

        // --- PERFECT LRC INJECTION ---
        if (lyricsData && lyricsData.lines && lyricsData.lines.length > 0) {
            
            const lrcLines = [];
            lrcLines.push(`[ti:${songTitle}]`);
            lrcLines.push(`[ar:${songArtist}]`);
            lrcLines.push(`[al:${songAlbum}]`);
            
            lyricsData.lines.forEach(l => {
                if (l.timeTag) {
                    const text = l.words ? l.words.trim() : ' '; // Space prevents parser crash on empty lines
                    lrcLines.push(`[${l.timeTag}]${text}`);
                }
            });

            const lrcText = lrcLines.join('\n');

            // 1. Unsynchronised Lyrics (Primary for Mi Music / Chinese OEMs)
            id3Tags.unsynchronisedLyrics = {
                language: 'eng',
                shortText: '',
                text: lrcText
            };

            // 2. Custom Frame (Specific fallback for strict Asian players)
            id3Tags.userDefinedText = [{
                description: 'LYRICS',
                value: lrcText
            }];

            // 3. Official Synchronised Frame (For modern Global players)
            if (lyricsData.syncType === "LINE_SYNCED") {
                id3Tags.synchronisedLyrics = [{
                    language: 'eng',
                    timeStampFormat: 2,
                    contentType: 1,
                    synchronisedText: lyricsData.lines.filter(l => l.timeTag).map(l => ({
                        text: l.words ? l.words.trim() : ' ',
                        timeStamp: convertTimeTagToMs(l.timeTag)
                    }))
                }];
            }
        }

        // Create buffer instantly
        const id3HeaderBuffer = NodeID3.create(id3Tags);

        // --- INSTANT STREAMING ---
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}.${outputFormat}"`);
        res.setHeader('Content-Type', 'audio/mpeg');

        // Send perfectly crafted ID3 tag first
        res.write(id3HeaderBuffer);

        // Run FFmpeg & Pipe purely Raw Audio
        ffmpeg(url)
            .outputOptions([
                '-vn',                   // Skip cover art in FFmpeg 
                '-f', 'mp3',             // Force raw MP3 stream out
                '-c:a', 'libmp3lame',    // MP3 encoder
                '-b:a', targetBitrate,   // Enforce Bitrate
                '-minrate', targetBitrate, // STRICT CBR: Helps Android map the timeline bytes
                '-maxrate', targetBitrate, // STRICT CBR
                '-map_metadata', '-1',   // Strip original M3U8 metadata
                '-write_id3v2', '0',     // Prevents FFmpeg from double-tagging
                '-write_xing', '0',      // CRITICAL FIX: Disables broken streaming header
                '-threads', '0'          // Use all available CPU cores
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
