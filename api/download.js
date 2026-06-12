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
    let { url, format } = req.query;

    if (!url) {
        return res.status(400).json({ error: "Missing M3U8 url parameter" });
    }

    // Ensure URL has https://
    if (!url.startsWith('http')) {
        url = 'https://' + url;
    }

    // Set headers to trigger an MP3 file download on mobile
    res.setHeader('Content-Disposition', `attachment; filename="audio.${format || 'mp3'}"`);
    res.setHeader('Content-Type', 'audio/mpeg');

    try {
        // Run FFmpeg
        ffmpeg(url)
            .format(format || 'mp3')
            .audioBitrate('128k') // 128k keeps processing fast to beat the 60s timeout
            .on('error', (err) => {
                console.error('FFmpeg Conversion Error:', err.message);
                if (!res.headersSent) {
                    res.status(500).json({ error: "FFmpeg Failed", details: err.message });
                }
            })
            .pipe(res, { end: true }); // Stream directly to the user

    } catch (err) {
        res.status(500).json({ error: "API Crashed", details: err.message });
    }
};
