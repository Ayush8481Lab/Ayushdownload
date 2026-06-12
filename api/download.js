const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');

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
        let { url, format, imageUrl, title, tittle, artist, album } = req.query;

        if (!url) return res.status(400).json({ error: "Missing M3U8 url parameter" });
        if (!url.startsWith('http')) url = 'https://' + url;

        // Clean quotes from variables to ensure clean ID3 injection
        const songTitle = String(title || tittle || 'Unknown Title').replace(/["']/g, "").trim();
        const songArtist = String(artist || 'Unknown Artist').replace(/["']/g, "").trim();
        const songAlbum = String(album || 'Unknown Album').replace(/["']/g, "").trim();
        const outputFormat = String(format || 'mp3');
        const safeFileName = songTitle.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/ /g, "_") || "audio_download";

        // Unique IDs for temporary files
        const sessionId = Date.now();
        const outPath = `/tmp/output_${sessionId}.${outputFormat}`;
        const imgPath = `/tmp/image_${sessionId}.jpg`;
        
        let hasImage = false;

        // 1. Download the Image manually
        if (imageUrl) {
            if (!imageUrl.startsWith('http')) imageUrl = 'https://' + imageUrl;
            try {
                const imgRes = await fetch(imageUrl, {
                    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" }
                });
                if (imgRes.ok) {
                    const arrayBuffer = await imgRes.arrayBuffer();
                    fs.writeFileSync(imgPath, Buffer.from(arrayBuffer));
                    hasImage = true;
                }
            } catch (e) {
                console.error("Failed to fetch image, continuing without it.", e);
            }
        }

        let command = ffmpeg(url);

        // 2. Setup strict FFmpeg MP3 encoding and Tagging Options
        let outputOptions = [
            '-f', 'mp3',                 // FORCE format to MP3
            '-c:a', 'libmp3lame',        // FORCE LAME MP3 Encoder (fixes AAC passthrough bug)
            '-b:a', '128k',              // Set Audio Bitrate
            '-map_metadata', '-1',       // Strip original HLS stream metadata entirely
            '-id3v2_version', '3',       // Force ID3v2.3 (Required for Windows/Android/iOS)
            '-write_id3v1', '1',         // Add ID3v1 fallback tags just in case
            
            // Wrapped in quotes to strictly bypass fluent-ffmpeg's space-splitting crash
            '-metadata', `"title=${songTitle}"`,
            '-metadata', `"artist=${songArtist}"`,
            '-metadata', `"album_artist=${songArtist}"`,
            '-metadata', `"album=${songAlbum}"`
        ];

        // 3. Explicitly map streams to drop hidden HLS data
        if (hasImage) {
            command.input(imgPath);
            outputOptions.push(
                '-map', '0:a:0',         // Map explicitly the FIRST audio track from M3U8
                '-map', '1:v:0',         // Map explicitly the FIRST video track from the image
                '-c:v', 'mjpeg',         // Convert image to standard jpeg
                '-metadata:s:v', '"title=Album cover"', 
                '-metadata:s:v', '"comment=Cover (front)"',
                '-disposition:v', 'attached_pic' 
            );
        } else {
            outputOptions.push('-map', '0:a:0'); // Only pull the clean audio track
        }

        command.outputOptions(outputOptions);

        // 4. Save to disk first, THEN send to user
        command.save(outPath)
            .on('end', () => {
                // EXTREMELY IMPORTANT: Prevent browser & Vercel from caching the old broken file!
                res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
                res.setHeader('Pragma', 'no-cache');
                res.setHeader('Expires', '0');
                
                res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}.${outputFormat}"`);
                res.setHeader('Content-Type', 'audio/mpeg');

                const readStream = fs.createReadStream(outPath);
                readStream.pipe(res);

                // Delete the temp files 
                readStream.on('end', () => {
                    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
                    if (hasImage && fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
                });
            })
            .on('error', (err) => {
                console.error('FFmpeg Error:', err.message);
                if (!res.headersSent) res.status(500).json({ error: "FFmpeg Failed", details: err.message });
                if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
                if (hasImage && fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
            });

    } catch (err) {
        if (!res.headersSent) {
            res.status(500).json({ error: "API Crashed", details: err.message });
        }
    }
};
