const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');

// Safely tell fluent-ffmpeg where the Vercel-compatible binary is
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

module.exports = (req, res) => {
    try {
        // 1. Grab parameters safely (force them to be strings to prevent TypeErrors)
        let url = req.query.url ? String(req.query.url) : '';
        let format = req.query.format ? String(req.query.format) : 'mp3';
        let imageUrl = req.query.imageUrl ? String(req.query.imageUrl) : '';
        
        let title = req.query.title || req.query.tittle || 'Unknown Title';
        let artist = req.query.artist || 'Unknown Artist';
        let album = req.query.album || 'Unknown Album';

        // Force text to be strings
        title = String(title);
        artist = String(artist);
        album = String(album);

        if (!url) {
            return res.status(400).json({ error: "Please provide an M3U8 url parameter" });
        }

        // Fix M3U8 URL if it misses https
        if (!url.startsWith('http')) {
            url = 'https://' + url;
        }

        // Create a safe file name without special characters to prevent download errors
        const safeFileName = title.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/ /g, "_") || "audio";

        res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}.${format}"`);
        res.setHeader('Content-Type', 'audio/mpeg');

        // 2. Setup FFmpeg Command
        let command = ffmpeg(url).format(format).audioBitrate('128k');
        
        // Setup Text Metadata
        let outputOptions = [
            '-metadata', `title=${title}`,
            '-metadata', `artist=${artist}`,
            '-metadata', `album=${album}`
        ];

        // 3. SAFE Image Handling (Only process if it's a real HTTP link)
        if (imageUrl && imageUrl.startsWith('http')) {
            command.input(imageUrl);
            outputOptions.push(
                '-map', '0:a',          // Map Audio
                '-map', '1:v',          // Map Video/Image
                '-c:v', 'mjpeg',        // Compress image to standard JPEG
                '-id3v2_version', '3',  // Use ID3v2.3 (Highest mobile compatibility)
                '-disposition:v', 'attached_pic' // Tag as Cover Art
            );
        } else if (imageUrl) {
            console.log("Ignored invalid image URL:", imageUrl);
        }

        command.outputOptions(outputOptions);

        // 4. Safe Error Handling
        command.on('error', (err) => {
            console.error('FFmpeg processing error:', err.message);
            // If headers are not sent, send a JSON error. Otherwise, end the stream safely.
            if (!res.headersSent) {
                res.status(500).json({ error: 'FFmpeg failed to process', details: err.message });
            } else {
                res.end();
            }
        });

        // 5. Pipe to Mobile Phone
        command.pipe(res, { end: true });

    } catch (err) {
        console.error('Server crash avoided:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'API Error', details: err.message });
        } else {
            res.end();
        }
    }
};
