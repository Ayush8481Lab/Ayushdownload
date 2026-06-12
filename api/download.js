const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');

// Safely tell fluent-ffmpeg where the Vercel-compatible binary is
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

module.exports = (req, res) => {
    try {
        // Grab all the new parameters from your URL
        let { url, format, imageUrl, artist, album, tittle, title } = req.query;

        // Fallbacks just in case a parameter is missing
        const songTitle = title || tittle || 'Unknown Title';
        const songArtist = artist || 'Unknown Artist';
        const songAlbum = album || 'Unknown Album';

        if (!url) {
            return res.status(400).json({ error: "Please provide an M3U8 url parameter" });
        }

        // Ensure URLs have https://
        if (!url.startsWith('http')) url = 'https://' + url;

        // Clean the filename so it doesn't break browser downloads (removes special chars)
        const safeFileName = songTitle.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/ /g, "_");

        res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}.${format || 'mp3'}"`);
        res.setHeader('Content-Type', 'audio/mpeg');

        // 1. Setup the main audio stream
        let command = ffmpeg().input(url);

        // 2. Set Format and Quality
        command.format(format || 'mp3').audioBitrate('128k');

        let outputOptions = [];

        // 3. Add the ID3 Text Metadata (Title, Artist, Album)
        outputOptions.push('-metadata', `title=${songTitle}`);
        outputOptions.push('-metadata', `artist=${songArtist}`);
        outputOptions.push('-metadata', `album=${songAlbum}`);

        // 4. Add the Cover Art Image!
        if (imageUrl) {
            if (!imageUrl.startsWith('http')) imageUrl = 'https://' + imageUrl;
            
            // Add the image as a secondary input
            command.input(imageUrl);
            
            // Map the audio and image together into a single file
            outputOptions.push(
                '-map', '0:a',          // Take audio from the 1st input (M3U8)
                '-map', '1:v',          // Take image from the 2nd input (ImageUrl)
                '-c:v', 'mjpeg',        // Convert image to standard jpeg inside the mp3
                '-id3v2_version', '3',  // Use ID3v2.3 (Highest compatibility for mobile phones)
                '-disposition:v', 'attached_pic' // Tell the MP3 player this is Cover Art!
            );
        }

        // Apply all our custom options to FFmpeg
        if (outputOptions.length > 0) {
            command.outputOptions(outputOptions);
        }

        // 5. Run the conversion and pipe directly to the user
        command.on('error', (err) => {
            console.error('FFmpeg Error:', err.message);
            if (!res.headersSent) {
                res.status(500).json({ error: "Conversion failed", details: err.message });
            }
        })
        .pipe(res, { end: true });

    } catch (error) {
        if (!res.headersSent) {
            res.status(500).json({ error: "System crash", details: error.message });
        }
    }
};
