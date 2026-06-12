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

        // Clean out any special characters
        const cleanStr = (str) => String(str).replace(/[=;#\\\n]/g, "").trim();
        const songTitle = cleanStr(title || tittle || 'Unknown Title');
        const songArtist = cleanStr(artist || 'Unknown Artist');
        const songAlbum = cleanStr(album || 'Unknown Album');
        
        const outputFormat = 'mp3'; // Force MP3 (ID3 tags only apply to MP3s)
        const safeFileName = songTitle.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/ /g, "_") || "audio_download";

        // DYNAMIC QUALITY EXTRACTOR
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

        // Task A: Fetch Image
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

        // Task B: Fetch Lyrics
        if (trackid) {
            const lyricsUrl = `https://lyr-nine.vercel.app/api/lyrics?url=https://open.spotify.com/track/${trackid}&format=lrc`;
            fetchTasks.push(
                fetch(lyricsUrl)
                    .then(async lyrRes => {
                        if (lyrRes.ok) lyricsData = await lyrRes.json();
                    }).catch(e => console.error("Lyrics fetch failed", e))
            );
        }

        // Wait for BOTH tasks concurrently
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

        // LYRICS FIX FOR MI MUSIC PLAYER AND OEM APPS
        if (lyricsData && lyricsData.lines && lyricsData.lines.length > 0) {
            let lrcText = "";
            let plainText = "";
            const syncLyrics = [];

            lyricsData.lines.forEach(l => {
                plainText += l.words + '\n';
                if (l.timeTag) {
                    // Recreate LRC format strictly eg: [01:25.97]Lyrics text here
                    lrcText += `[${l.timeTag}]${l.words}\n`;
                    syncLyrics.push({
                        text: l.words,
                        timeStamp: convertTimeTagToMs(l.timeTag)
                    });
                }
            });

            if (lyricsData.syncType === "LINE_SYNCED" && syncLyrics.length > 0) {
                // 1. Mi Music looks for the .LRC parsed string directly inside the USLT tag
                id3Tags.unsynchronisedLyrics = {
                    language: 'eng',
                    text: lrcText.trim()
                };

                // 2. Standard SYLT (For players that natively support the binary synced tag)
                id3Tags.synchronisedLyrics = [{
                    language: 'eng',
                    timeStampFormat: 2,
                    contentType: 1,
                    synchronisedText: syncLyrics
                }];

                // 3. Fallback for players that strictly read custom TXXX:LYRICS
                id3Tags.userDefinedText = [{
                    description: 'LYRICS',
                    value: lrcText.trim()
                }];
            } else {
                id3Tags.unsynchronisedLyrics = {
                    language: 'eng',
                    text: plainText.trim()
                };
            }
        }

        // Create the raw ID3v2 header buffer instantly (ZERO disk I/O)
        const id3HeaderBuffer = NodeID3.create(id3Tags);

        // --- OPTIMIZATION 3: INSTANT STREAMING ---
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}.${outputFormat}"`);
        res.setHeader('Content-Type', 'audio/mpeg');

        // Prepend our properly formatted ID3 tag right at the front!
        res.write(id3HeaderBuffer);

        // Run FFmpeg & Pipe purely Raw Audio data
        ffmpeg(url)
            .outputOptions([
                '-vn',                   // Skip cover art in FFmpeg (We handled it above)
                '-f', 'mp3',             // Force raw MP3 stream out
                '-c:a', 'libmp3lame',    // MP3 encoder
                '-b:a', targetBitrate,   // Quality enforcement
                '-map_metadata', '-1',   // Strip original metadata
                '-write_id3v2', '0',     // 🚫 CRITICAL FIX: Prevent FFmpeg from generating a duplicate ID3v2 tag!
                '-id3v2_version', '0',   // 🚫 Ensures no empty metadata header hides your injected ID3
                '-threads', '0'          // Use all available CPU cores for decoding
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
            res.end(); // Fail gracefully if stream already started
        }
    }
};
