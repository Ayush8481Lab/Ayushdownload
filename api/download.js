const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');

// VERCEL HACK: Copy FFmpeg to /tmp and give it execute permissions
const tmpFfmpegPath = '/tmp/ffmpeg';

try {
    if (!fs.existsSync(tmpFfmpegPath)) {
        fs.copyFileSync(ffmpegPath, tmpFfmpegPath);
        fs.chmodSync(tmpFfmpegPath, 0o755); // 0755 grants execution rights
    }
    ffmpeg.setFfmpegPath(tmpFfmpegPath);
} catch (error) {
    console.error("Failed to setup FFmpeg in /tmp:", error);
}

module.exports = (req, res) => {
    try {
        // 1. Grab parameters safely
        let { url, format, imageUrl, title, tittle, artist, album } = req.query;

        if (!url) {
            return res.status(400).json({ error: "Missing M3U8 url parameter" });
        }

        // Ensure URL has https://
        if (!url.startsWith('http')) {
            url = 'https://' + url;
        }

        // 2. Set Fallback Metadata
        const songTitle = String(title || tittle || 'Unknown Title');
        const songArtist = String(artist || 'Unknown Artist');
        const songAlbum = String(album || 'Unknown Album');
        const outputFormat = String(format || 'mp3');

        // Create a safe file name (removes special characters)
        const safeFileName = songTitle.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/ /g, "_") || "audio_download";

        // Set headers to trigger file download on mobile
        res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}.${outputFormat}"`);
        res.setHeader('Content-Type', 'audio/mpeg');

        // 3. Setup FFmpeg Command using your working base
        let command = ffmpeg(url).format(outputFormat).audioBitrate('128k');

        // Add Text Metadata (Title, Artist, Album)
        let outputOptions = [
            '-metadata', `title=${songTitle}`,
            '-metadata', `artist=${songArtist}`,
            '-metadata', `album=${songAlbum}`
        ];

        // 4. Add Image Cover Art IF a valid link is provided
        if (imageUrl && imageUrl.startsWith('http')) {
            command.input(imageUrl);
            outputOptions.push(
                '-map', '0:a',          // Map Audio
                '-map', '1:v',          // Map Image
                '-c:v', 'mjpeg',        // Convert image to jpeg
                '-id3v2_version', '3',  // Use mobile-friendly ID3 tags
                '-disposition:v', 'attached_pic' // Set as Cover Art!
            );
        }

        // Apply options
        command.outputOptions(outputOptions);

        // 5. Run FFmpeg and stream directly to the user
        command.on('error', (err) => {
            console.error('FFmpeg Conversion Error:', err.message);
            if (!res.headersSent) {
                res.status(500).json({ error: "FFmpeg Failed", details: err.message });
            } else {
                res.end(); // Safely end stream if it fails halfway
            }
        }).pipe(res, { end: true });

    } catch (err) {
        if (!res.headersSent) {
            res.status(500).json({ error: "API Crashed", details: err.message });
        }
    }
};
