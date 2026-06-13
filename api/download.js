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

module.exports = async (req, res) => {
    try {
        let { url, imageUrl, title, tittle, artist, album } = req.query;

        if (!url) return res.status(400).json({ error: "Missing M3U8 url parameter" });
        if (!url.startsWith('http')) url = 'https://' + url;

        // Clean out special characters that might break ID3 tags
        const cleanStr = (str) => String(str).replace(/[=;#\\\n]/g, "").trim();
        const songTitle = cleanStr(title || tittle || 'Unknown Title');
        const songArtist = cleanStr(artist || 'Unknown Artist');
        const songAlbum = cleanStr(album || 'Unknown Album');
        
        const outputFormat = 'mp3'; 
        
        // FILENAME FIX: Removed `"` from the regex so double quotes are preserved.
        // We only strip characters that fatally break file paths (/ \ : * ? < > |)
        const safeFileName = songTitle.replace(/[/\\:*?<>|]/g, "").trim() || "audio_download";

        // DYNAMIC QUALITY EXTRACTOR
        let targetBitrate = '320k'; 
        const qualityMatch = url.match(/\/(\d+)\.mp4/);
        if (qualityMatch && qualityMatch[1]) {
            targetBitrate = `${qualityMatch[1]}k`; 
        }

        // --- OPTIMIZATION 1: FETCH IMAGE FAST ---
        let imageBuffer = null;
        let imageMime = 'image/jpeg';

        if (imageUrl) {
            if (!imageUrl.startsWith('http')) imageUrl = 'https://' + imageUrl;
            try {
                const imgRes = await fetch(imageUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
                if (imgRes.ok) {
                    const contentType = imgRes.headers.get('content-type') || '';
                    if (contentType.includes('webp')) imageMime = 'image/webp';
                    else if (contentType.includes('png')) imageMime = 'image/png';
                    
                    const arrayBuf = await imgRes.arrayBuffer();
                    imageBuffer = Buffer.from(arrayBuf);
                }
            } catch (e) {
                console.error("Image fetch failed", e);
            }
        }

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

        // Create the raw ID3v2 header buffer instantly
        const id3HeaderBuffer = NodeID3.create(id3Tags);

        // --- OPTIMIZATION 3: INSTANT STREAMING ---
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        
        // FILENAME FIX: 
        // 1. Fallback name replaces `"` with `'` because raw double quotes break the HTTP header syntax (filename="...").
        // 2. encodedName perfectly preserves `"` as `%22`, allowing modern browsers to parse it as exactly what you want.
        const fallbackName = safeFileName.replace(/"/g, "'");
        const encodedName = encodeURIComponent(safeFileName);

        res.setHeader('Content-Disposition', `attachment; filename="${fallbackName}.${outputFormat}"; filename*=UTF-8''${encodedName}.${outputFormat}`);
        res.setHeader('Content-Type', 'audio/mpeg');

        // Send the ID3 Tag Header immediately
        res.write(id3HeaderBuffer);

        // Run FFmpeg & Pipe purely Raw Audio data
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
        if (!res.headersSent) {
            res.status(500).json({ error: "API Crashed", details: err.message });
        } else {
            res.end(); 
        }
    }
};
