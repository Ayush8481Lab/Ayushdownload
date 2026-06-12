const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const crypto = require('crypto');
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

// Helper: Converts time string "01:25.97" into milliseconds for ID3 Sync
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
        
        const outputFormat = 'mp3';
        const safeFileName = songTitle.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/ /g, "_") || "audio_download";

        // DYNAMIC QUALITY EXTRACTOR
        let targetBitrate = '320k'; 
        const qualityMatch = url.match(/\/(\d+)\.mp4/);
        if (qualityMatch && qualityMatch[1]) {
            targetBitrate = `${qualityMatch[1]}k`; 
        }

        // --- FETCH DATA CONCURRENTLY ---
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

        // --- THE PERFECT FILE PIPELINE ---
        // Instead of streaming blindly, we generate a flawless file in /tmp first.
        const fileId = crypto.randomBytes(6).toString('hex');
        const tmpAudioPath = `/tmp/audio_${fileId}.mp3`;

        // 1. Download and Encode the Audio 
        await new Promise((resolve, reject) => {
            ffmpeg(url)
                .outputOptions([
                    '-vn',                   // Skip video/image
                    '-c:a', 'libmp3lame',    // Enforce pure MP3
                    '-b:a', targetBitrate,   // Quality enforcement
                    '-map_metadata', '-1',   // Erase garbage metadata
                    '-threads', '0'          // Multi-thread for fast completion
                ])
                .save(tmpAudioPath)          // Save to fast local Vercel memory
                .on('end', resolve)
                .on('error', reject);
        });

        // 2. Build the ID3 tags
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

        // 3. Inject Lyrics tailored PERFECTLY for Android/Mi Music
        if (lyricsData && Array.isArray(lyricsData.lines) && lyricsData.lines.length > 0) {
            
            // Build strictly formatted LRC string
            let lrcText = `[ti:${songTitle}]\n[ar:${songArtist}]\n[al:${songAlbum}]\n`;
            lrcText += lyricsData.lines.map(l => {
                const time = l.timeTag || '00:00.00';
                const words = (l.words || '').trim(); // Remove empty noise
                return `[${time}]${words}`;
            }).join('\n');

            // Tag A: Unsynchronised Lyrics (Primary Mi Music Scanner)
            id3Tags.unsynchronisedLyrics = {
                language: 'XXX',    // 'XXX' forces Chinese players to accept it regardless of phone language
                shortText: '',      // Crucial: leave description empty
                text: lrcText
            };

            // Tag B: TXXX Fallback (For strictly mapped OEM Parsers)
            id3Tags.userDefinedText = [{
                description: 'LYRICS',
                value: lrcText
            }];

            // Tag C: Official SYLT Frame (For modern global players)
            if (lyricsData.syncType === "LINE_SYNCED") {
                id3Tags.synchronisedLyrics = [{
                    language: 'XXX',
                    timeStampFormat: 2,
                    contentType: 1,
                    shortText: '',
                    synchronisedText: lyricsData.lines.map(l => ({
                        text: (l.words || '').trim() || ' ', // Prevents crash on empty tags
                        timeStamp: convertTimeTagToMs(l.timeTag)
                    }))
                }];
            }
        }

        // 4. Inject Tags perfectly into the file (Guarantees no double-tag corruption)
        NodeID3.write(id3Tags, tmpAudioPath);

        // 5. Read the final file size
        const stat = fs.statSync(tmpAudioPath);

        // --- SEND THE FILE ---
        // Setting Content-Length is what fixes the missing timeline duration bug!
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.setHeader('Content-Length', stat.size);
        res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}.${outputFormat}"`);
        res.setHeader('Content-Type', 'audio/mpeg');

        const readStream = fs.createReadStream(tmpAudioPath);
        readStream.pipe(res);

        // Cleanup temporary memory once file is safely sent
        readStream.on('close', () => {
            try { fs.unlinkSync(tmpAudioPath); } catch (e) {}
        });
        readStream.on('error', () => {
            try { fs.unlinkSync(tmpAudioPath); } catch (e) {}
        });

    } catch (err) {
        console.error('API Error:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: "API Crashed", details: err.message });
        } else {
            res.end();
        }
    }
};
