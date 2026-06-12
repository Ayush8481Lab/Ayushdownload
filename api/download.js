const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const NodeID3 = require('node-id3'); // <-- NEW: Required for deep Synced Lyrics (SYLT)

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

        // Clean out any special characters that could break the FFMETADATA file
        const cleanStr = (str) => String(str).replace(/[=;#\\\n]/g, "").trim();
        const songTitle = cleanStr(title || tittle || 'Unknown Title');
        const songArtist = cleanStr(artist || 'Unknown Artist');
        const songAlbum = cleanStr(album || 'Unknown Album');
        
        const outputFormat = String(format || 'mp3');
        const safeFileName = songTitle.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/ /g, "_") || "audio_download";

        // DYNAMIC QUALITY EXTRACTOR
        let targetBitrate = '320k'; 
        const qualityMatch = url.match(/\/(\d+)\.mp4/);
        if (qualityMatch && qualityMatch[1]) {
            targetBitrate = `${qualityMatch[1]}k`; 
        }

        const sessionId = Date.now() + Math.floor(Math.random() * 1000);
        const outPath = `/tmp/output_${sessionId}.${outputFormat}`;
        const metaPath = `/tmp/meta_${sessionId}.txt`; 
        let imgPath = `/tmp/image_${sessionId}.jpg`; // Fallback default extension
        
        let hasImage = false;

        // 1. Create the bulletproof FFMETADATA text file
        const metaContent = `;FFMETADATA1\ntitle=${songTitle}\nartist=${songArtist}\nalbum_artist=${songArtist}\nalbum=${songAlbum}\n`;
        fs.writeFileSync(metaPath, metaContent);

        // 2. Download the Image manually (WebP Compatible)
        if (imageUrl) {
            if (!imageUrl.startsWith('http')) imageUrl = 'https://' + imageUrl;
            try {
                const imgRes = await fetch(imageUrl, {
                    headers: { "User-Agent": "Mozilla/5.0" }
                });
                if (imgRes.ok) {
                    // Detect if the server returns WebP/PNG so FFmpeg treats it accurately
                    const contentType = imgRes.headers.get('content-type') || '';
                    if (contentType.includes('webp')) imgPath = `/tmp/image_${sessionId}.webp`;
                    else if (contentType.includes('png')) imgPath = `/tmp/image_${sessionId}.png`;

                    const arrayBuffer = await imgRes.arrayBuffer();
                    fs.writeFileSync(imgPath, Buffer.from(arrayBuffer));
                    hasImage = true;
                }
            } catch (e) {
                console.error("Failed to fetch image, continuing without it.", e);
            }
        }

        // --- NEW: 3. Fetch Lyrics from API ---
        let lyricsData = null;
        if (trackid && outputFormat === 'mp3') {
            try {
                const lyricsUrl = `https://lyr-nine.vercel.app/api/lyrics?url=https://open.spotify.com/track/${trackid}&format=lrc`;
                const lyrRes = await fetch(lyricsUrl);
                if (lyrRes.ok) {
                    lyricsData = await lyrRes.json();
                }
            } catch (e) {
                console.error("Failed to fetch lyrics:", e);
            }
        }

        let command = ffmpeg(url); 

        // 4. Setup strict FFmpeg MP3 encoding Options
        let outputOptions = [
            '-f', 'mp3',                 
            '-c:a', 'libmp3lame',        
            '-b:a', targetBitrate,       
            '-id3v2_version', '3',       
            '-write_id3v1', '1'          
        ];

        // Input files and mapping
        if (hasImage) {
            command.input(imgPath);      
            command.input(metaPath);     
            
            outputOptions.push(
                '-map', '0:a:0',         
                '-map', '1:v:0',         
                '-map_metadata', '2',    
                '-c:v', 'mjpeg',         // Forces webp/png into standard JPEG MP3 Cover Art
                '-disposition:v', 'attached_pic' 
            );
        } else {
            command.input(metaPath);     
            
            outputOptions.push(
                '-map', '0:a:0',         
                '-map_metadata', '1'     
            );
        }

        command.outputOptions(outputOptions);

        const cleanupTempFiles = () => {
            if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
            if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
            if (hasImage && fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
        };

        // 5. Save to disk, Deeply Embed Lyrics, THEN send to user
        command.save(outPath)
            .on('end', () => {
                
                // --- NEW: DEEP EMBED LYRICS USING node-id3 ---
                if (lyricsData && lyricsData.lines && lyricsData.lines.length > 0 && outputFormat === 'mp3') {
                    try {
                        let id3Tags = {};
                        const rawText = lyricsData.lines.map(l => l.words).join('\n');
                        
                        if (lyricsData.syncType === "LINE_SYNCED") {
                            // Embed Synced Lyrics Frame (SYLT)
                            id3Tags.synchronisedLyrics = [{
                                language: 'eng',
                                timeStampFormat: 2, // Milliseconds Standard
                                contentType: 1,     // "Lyrics" designation
                                synchronisedText: lyricsData.lines.map(l => ({
                                    text: l.words,
                                    timeStamp: convertTimeTagToMs(l.timeTag)
                                }))
                            }];
                            // Embed a standard USLT block as a fallback for players that don't support scrolling lyrics
                            id3Tags.unsynchronisedLyrics = {
                                language: 'eng',
                                text: rawText
                            };
                        } else {
                            // Embed Unsynced Lyrics Frame (USLT)
                            id3Tags.unsynchronisedLyrics = {
                                language: 'eng',
                                text: rawText
                            };
                        }
                        
                        // Execute the synchronous deep metadata injection
                        NodeID3.update(id3Tags, outPath);
                    } catch (lyrErr) {
                        console.error("Deep lyrics embedding failed:", lyrErr);
                    }
                }

                // Serve the resulting file
                res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
                res.setHeader('Pragma', 'no-cache');
                res.setHeader('Expires', '0');
                
                res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}.${outputFormat}"`);
                res.setHeader('Content-Type', 'audio/mpeg');

                const readStream = fs.createReadStream(outPath);
                readStream.pipe(res);

                readStream.on('end', cleanupTempFiles);
            })
            .on('error', (err) => {
                console.error('FFmpeg Error:', err.message);
                if (!res.headersSent) res.status(500).json({ error: "FFmpeg Failed", details: err.message });
                cleanupTempFiles();
            });

    } catch (err) {
        if (!res.headersSent) {
            res.status(500).json({ error: "API Crashed", details: err.message });
        }
    }
};
