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

        // Clean out any special characters that could break the FFMETADATA file (=, ;, #, \)
        const cleanStr = (str) => String(str).replace(/[=;#\\\n]/g, "").trim();
        const songTitle = cleanStr(title || tittle || 'Unknown Title');
        const songArtist = cleanStr(artist || 'Unknown Artist');
        const songAlbum = cleanStr(album || 'Unknown Album');
        
        const outputFormat = String(format || 'mp3');
        const safeFileName = songTitle.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/ /g, "_") || "audio_download";

        // --- NEW: DYNAMIC QUALITY EXTRACTOR ---
        // Reads the original quality (320, 128, 64, 16) directly from your Gaana M3U8 URL
        let targetBitrate = '320k'; // Default to maximum quality if no number is found
        const qualityMatch = url.match(/\/(\d+)\.mp4/);
        if (qualityMatch && qualityMatch[1]) {
            targetBitrate = `${qualityMatch[1]}k`; // Automatically becomes '320k', '128k', etc.
        }

        // Unique IDs for all our temporary files
        const sessionId = Date.now() + Math.floor(Math.random() * 1000);
        const outPath = `/tmp/output_${sessionId}.${outputFormat}`;
        const imgPath = `/tmp/image_${sessionId}.jpg`;
        const metaPath = `/tmp/meta_${sessionId}.txt`; 
        
        let hasImage = false;

        // 1. Create the bulletproof FFMETADATA text file
        const metaContent = `;FFMETADATA1\ntitle=${songTitle}\nartist=${songArtist}\nalbum_artist=${songArtist}\nalbum=${songAlbum}\n`;
        fs.writeFileSync(metaPath, metaContent);

        // 2. Download the Image manually
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

        // 3. Setup strict FFmpeg MP3 encoding Options
        let outputOptions = [
            '-f', 'mp3',                 
            '-c:a', 'libmp3lame',        
            '-b:a', targetBitrate,       // NEW: Enforces the EXACT original bitrate extracted from URL
            '-id3v2_version', '3',       
            '-write_id3v1', '1'          
        ];

        // 4. Input files and mapping
        if (hasImage) {
            command.input(imgPath);      
            command.input(metaPath);     
            
            outputOptions.push(
                '-map', '0:a:0',         
                '-map', '1:v:0',         
                '-map_metadata', '2',    
                '-c:v', 'mjpeg',         
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

        // Helper to safely delete temp files
        const cleanupTempFiles = () => {
            if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
            if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
            if (hasImage && fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
        };

        // 5. Save to disk first, THEN send to user
        command.save(outPath)
            .on('end', () => {
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
