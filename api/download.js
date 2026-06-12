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

        // Clean quotes from variables so they don't interfere with our fluent-ffmpeg workaround
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

        let command = ffmpeg(url).audioBitrate('128k');

        // 2. Setup FFmpeg Metadata Options 
        let outputOptions = [
            // CRITICAL FIX 1: Wipes the invisible blank tags from the M3U8 stream so Artist shows up
            '-map_metadata', '-1', 
            
            // CRITICAL FIX 2: Variables are wrapped in `" "` to stop the fluent-ffmpeg space crash
            '-metadata', `"title=${songTitle}"`,
            '-metadata', `"artist=${songArtist}"`,
            '-metadata', `"album_artist=${songArtist}"`,
            '-metadata', `"album=${songAlbum}"`
        ];

        // 3. Attach Local Image IF downloaded successfully
        if (hasImage) {
            command.input(imgPath);
            outputOptions.push(
                '-map', '0:a',          
                '-map', '1:v',          
                '-c:v', 'mjpeg',        
                '-id3v2_version', '3',   // Forces metadata to ID3v2.3 (Required for mobile phones)
                '-metadata:s:v', '"title=Album_Cover"',  // Wrapped in quotes AND underscored just to be 1000% safe
                '-metadata:s:v', '"comment=Cover_Front"',
                '-disposition:v', 'attached_pic' 
            );
        } else {
            // Still enforce ID3v2.3 even if there's no image
            outputOptions.push('-id3v2_version', '3');
        }

        command.outputOptions(outputOptions);

        // 4. Save to disk first, THEN send to user
        command.save(outPath)
            .on('end', () => {
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
