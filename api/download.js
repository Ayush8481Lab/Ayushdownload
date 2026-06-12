const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');

// Safely tell fluent-ffmpeg where the Vercel-compatible binary is
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

module.exports = (req, res) => {
    try {
        let { url, format } = req.query;

        if (!url) {
            return res.status(400).json({ error: "Please provide an M3U8 url parameter" });
        }

        if (!url.startsWith('http')) {
            url = 'https://' + url;
        }

        res.setHeader('Content-Disposition', `attachment; filename="audio.${format || 'mp3'}"`);
        res.setHeader('Content-Type', 'audio/mpeg');

        ffmpeg(url)
            .format(format || 'mp3')
            .audioBitrate('128k')
            .on('error', (err) => {
                console.error('FFmpeg Error:', err.message);
                if (!res.headersSent) {
                    res.status(500).json({ error: "Conversion failed", details: err.message });
                }
            })
            .pipe(res, { end: true });

    } catch (error) {
        // This prevents the whole Vercel function from crashing!
        res.status(500).json({ error: "System crash", details: error.message });
    }
};
