const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');

// Tell the API where the FFmpeg engine is
ffmpeg.setFfmpegPath(ffmpegStatic);

module.exports = (req, res) => {
    let { url, format } = req.query;

    if (!url) {
        return res.status(400).json({ error: "Please provide an M3U8 url parameter" });
    }

    // Ensure the URL has https:// (helps with the Gaana link you provided)
    if (!url.startsWith('http')) {
        url = 'https://' + url;
    }

    // Set the headers so the browser/app downloads it as an MP3 file
    res.setHeader('Content-Disposition', `attachment; filename="audio.${format || 'mp3'}"`);
    res.setHeader('Content-Type', 'audio/mpeg');

    // Run FFmpeg: It fetches the M3U8, converts it, and pipes it directly to the user!
    ffmpeg(url)
        .format(format || 'mp3')
        .audioBitrate('128k') // 128k is good quality and keeps the file size small
        .on('error', (err) => {
            console.error('Error:', err.message);
            if (!res.headersSent) {
                res.status(500).send('Conversion failed: ' + err.message);
            }
        })
        .pipe(res, { end: true });
};
