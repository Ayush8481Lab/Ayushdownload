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

// Helper: Converts time string "01:25.97" into milliseconds
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

// Helper: Converts MS to standard LRC "mm:ss.xx" tag
const formatTimeMsToTag = (ms) => {
    const min = Math.floor(ms / 60000);
    const sec = ((ms % 60000) / 1000).toFixed(2);
    return `${min < 10 ? '0' : ''}${min}:${sec < 10 ? '0' : ''}${sec}`;
};

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
        
        // CACHE-BUSTING: Add a random ID to the filename so Android MediaStore is FORCED to re-scan the ID3 tags!
        const uniqueId = Math.floor(Math.random() * 10000);
        const safeFileName = `${songTitle.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/ /g, "_")}_${uniqueId}`;

        let targetBitrate = '320k'; 
        const qualityMatch = url.match(/\/(\d+)\.mp4/);
        if (qualityMatch && qualityMatch[1]) {
            targetBitrate = `${qualityMatch[1]}k`; 
        }

        // --- OPTIMIZATION 1: PARALLEL NETWORK REQUESTS ---
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

        // --- OPTIMIZATION 2: IN-MEMORY ID3 CONSTRUCTION ---
        const id3Tags = {
            title: songTitle,
            artist: songArtist,
            album: songAlbum,
            performerInfo: songArtist // Maps to Album Artist
        };

        if (imageBuffer) {
            id3Tags.image = {
                mime: imageMime,
                type: { id: 3, name: 'front cover' },
                description: 'Cover Art',
                imageBuffer: imageBuffer
            };
        }

        // --- THE DEEP LYRICS FIX ---
        if (lyricsData && lyricsData.lines && lyricsData.lines.length > 0) {
            
            // 1. Mandatory metadata headers required by Mi Music & Android offline parsers
            let lrcText = `[ti:${songTitle}]\r\n[ar:${songArtist}]\r\n[al:${songAlbum}]\r\n`;
            let plainText = "";
            const syncLyrics = [];

            lyricsData.lines.forEach(l => {
                let textLine = (l.words || l.text || "").trim();
                
                // Native parsers strictly require \r\n (Carriage Return + Line Feed)
                plainText += textLine + '\r\n';
                
                // Fallback calculations for timing just in case the API omits the timeTag
                let ms = 0;
                let timeStr = "";

                if (l.timeTag) {
                    timeStr = l.timeTag;
                    ms = convertTimeTagToMs(l.timeTag);
                } else if (l.startTimeMs) {
                    ms = parseInt(l.startTimeMs, 10);
                    timeStr = formatTimeMsToTag(ms);
                }

                if (timeStr && ms > 0) {
                    lrcText += `[${timeStr}]${textLine}\r\n`;
                    syncLyrics.push({
                        text: textLine,
                        timeStamp: ms
                    });
                }
            });

            if (syncLyrics.length > 0) {
                // PRIMARY: The main lyrics tag Mi Music natively defaults to
                id3Tags.unsynchronisedLyrics = {
                    language: 'eng',
                    description: '', // CRITICAL: Leaving this strictly empty forces it to be the "Default" lyric frame
                    text: lrcText.trim()
                };

                // SECONDARY: Standard binary SYLT tag (for advanced players)
                id3Tags.synchronisedLyrics = [{
                    language: 'eng',
                    timeStampFormat: 2, 
                    contentType: 1,     
                    shortText: '',
                    synchronisedText: syncLyrics
                }];

                // TERTIARY: TXXX Fallback for older OEM Android music players
                id3Tags.userDefinedText = [{
                    description: 'LYRICS',
                    value: lrcText.trim()
                }];
            } else {
                id3Tags.unsynchronisedLyrics = {
                    language: 'eng',
                    description: '',
                    text: plainText.trim()
                };
            }
        }

        // Create the raw ID3v2 header buffer
        const id3HeaderBuffer = NodeID3.create(id3Tags);

        // --- OPTIMIZATION 3: INSTANT STREAMING ---
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}.${outputFormat}"`);
        res.setHeader('Content-Type', 'audio/mpeg');

        // Prepend properly formatted ID3 tag right at the front
        res.write(id3HeaderBuffer);

        // Run FFmpeg & Pipe Pure Audio Data
        ffmpeg(url)
            .outputOptions([
                '-vn',                   // Skip cover art in FFmpeg (Handled natively)
                '-f', 'mp3',             // Force raw MP3 stream out
                '-c:a', 'libmp3lame',    // MP3 encoder
                '-b:a', targetBitrate,   // Quality enforcement
                '-map_metadata', '-1',   // Strip original metadata
                '-write_id3v2', '0',     // 🚫 Block FFmpeg from writing overlapping ID3v2 tag
                '-write_id3v1', '0',     // 🚫 Block FFmpeg from writing ID3v1 trailing tag
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
