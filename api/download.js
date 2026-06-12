import React, { useState, useRef } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import NodeID3 from 'node-id3';
import { Buffer } from 'buffer';

export default function FrontendDownloader() {
    const ffmpegRef = useRef(new FFmpeg());
    const [status, setStatus] = useState("Ready");
    const [progress, setProgress] = useState(0);

    // Inputs
    const [url, setUrl] = useState("");
    const [title, setTitle] = useState("Unknown Title");
    const [artist, setArtist] = useState("Unknown Artist");
    const [album, setAlbum] = useState("Unknown Album");
    const [imageUrl, setImageUrl] = useState("");
    const [trackid, setTrackid] = useState("");

    const convertTimeTagToMs = (timeTag) => {
        if (!timeTag) return 0;
        const parts = timeTag.split(':');
        if (parts.length >= 2) {
            const minutes = parseInt(parts[0], 10);
            const seconds = parseFloat(parts[1]);
            return Math.floor((minutes * 60 + seconds) * 1000);
        }
        return 0;
    };

    // --- M3U8 DOWNLOADER (Built for the Browser) ---
    const downloadM3U8ToMemory = async (playlistUrl, ffmpeg) => {
        setStatus("Parsing M3U8 Playlist...");
        const res = await fetch(playlistUrl);
        const text = await res.text();

        // 1. If Master Playlist, find the highest quality sub-playlist
        if (text.includes('#EXT-X-STREAM-INF')) {
            const lines = text.split('\n');
            let bestUrl = '';
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith('#EXT-X-STREAM-INF')) bestUrl = lines[i + 1].trim();
            }
            const absoluteUrl = new URL(bestUrl, playlistUrl).href;
            return downloadM3U8ToMemory(absoluteUrl, ffmpeg);
        }

        // 2. Parse Segments
        const lines = text.split('\n');
        let localM3u8 = "";
        let segments = [];

        for (let line of lines) {
            let tLine = line.trim();
            if (!tLine) continue;
            if (tLine.startsWith('#')) {
                localM3u8 += tLine + '\n';
            } else {
                const segUrl = new URL(tLine, playlistUrl).href;
                const segName = `seg_${segments.length}.ts`;
                localM3u8 += segName + '\n';
                segments.push({ name: segName, url: segUrl });
            }
        }

        // 3. Download segments in batches (Super Fast Parallel Download)
        for (let i = 0; i < segments.length; i += 10) {
            const batch = segments.slice(i, i + 10);
            await Promise.all(batch.map(async (seg) => {
                const r = await fetch(seg.url);
                const buf = await r.arrayBuffer();
                await ffmpeg.writeFile(seg.name, new Uint8Array(buf));
            }));
            setStatus(`Downloaded Audio Chunks: ${Math.min(i + 10, segments.length)} / ${segments.length}`);
            setProgress(((i + 10) / segments.length) * 100);
        }

        await ffmpeg.writeFile('local.m3u8', localM3u8);
        return 'local.m3u8';
    };

    const handleDownload = async () => {
        try {
            setStatus("Initializing System...");
            setProgress(0);
            const ffmpeg = ffmpegRef.current;

            // Load FFmpeg safely in the browser without SharedArrayBuffer errors
            if (!ffmpeg.loaded) {
                const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
                await ffmpeg.load({
                    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
                    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
                });
            }

            // --- 1. PARALLEL FETCH LYRICS AND IMAGE ---
            setStatus("Fetching Metadata & Cover Art...");
            let imageBuffer = null;
            let imageMime = 'image/jpeg';
            let lyricsData = null;

            const fetchTasks = [];

            if (imageUrl) {
                fetchTasks.push(
                    fetch(imageUrl).then(async imgRes => {
                        if (imgRes.ok) {
                            const ct = imgRes.headers.get('content-type') || '';
                            if (ct.includes('png')) imageMime = 'image/png';
                            imageBuffer = Buffer.from(await imgRes.arrayBuffer());
                        }
                    }).catch(e => console.error("Image error", e))
                );
            }

            if (trackid) {
                fetchTasks.push(
                    fetch(`https://lyr-nine.vercel.app/api/lyrics?url=https://open.spotify.com/track/${trackid}&format=lrc`)
                        .then(async lyrRes => {
                            if (lyrRes.ok) lyricsData = await lyrRes.json();
                        }).catch(e => console.error("Lyrics error", e))
                );
            }

            await Promise.all(fetchTasks);

            // --- 2. DOWNLOAD M3U8 ---
            const m3u8Filename = await downloadM3U8ToMemory(url, ffmpeg);

            // --- 3. CONVERT TO MP3 USING FFMPEG.WASM ---
            setStatus("Converting to MP3...");
            await ffmpeg.exec([
                '-i', m3u8Filename,
                '-c:a', 'libmp3lame',
                '-b:a', '320k',
                '-compression_level', '0', // Fastest encoding speed
                '-map_metadata', '-1',     // Strip junk metadata
                'output.mp3'
            ]);

            const rawMp3Data = await ffmpeg.readFile('output.mp3');
            let finalMp3Buffer = Buffer.from(rawMp3Data.buffer);

            // --- 4. DEEP ID3 TAGGING (SYLT + Cover Art) ---
            setStatus("Embedding Synced Lyrics & Cover Art...");
            const id3Tags = {
                title: title.trim(),
                artist: artist.trim(),
                album: album.trim(),
                performerInfo: artist.trim()
            };

            if (imageBuffer) {
                id3Tags.image = {
                    mime: imageMime,
                    type: { id: 3, name: 'front cover' },
                    description: 'Cover Art',
                    imageBuffer: imageBuffer
                };
            }

            if (lyricsData && lyricsData.lines && lyricsData.lines.length > 0) {
                const rawText = lyricsData.lines.map(l => l.words).join('\n');
                if (lyricsData.syncType === "LINE_SYNCED") {
                    id3Tags.synchronisedLyrics = [{
                        language: 'eng',
                        timeStampFormat: 2,
                        contentType: 1,
                        synchronisedText: lyricsData.lines.map(l => ({
                            text: l.words,
                            timeStamp: convertTimeTagToMs(l.timeTag)
                        }))
                    }];
                }
                id3Tags.unsynchronisedLyrics = {
                    language: 'eng',
                    text: rawText
                };
            }

            // Inject the ID3 metadata deeply into the file
            finalMp3Buffer = NodeID3.update(id3Tags, finalMp3Buffer);

            // --- 5. TRIGGER BROWSER DOWNLOAD ---
            setStatus("Complete! Saving File...");
            const blob = new Blob([finalMp3Buffer], { type: 'audio/mpeg' });
            const downloadUrl = URL.createObjectURL(blob);
            
            const safeFileName = title.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/ /g, "_") || "audio_download";
            const a = document.createElement('a');
            a.href = downloadUrl;
            a.download = `${safeFileName}.mp3`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            
            setStatus("Downloaded Successfully!");

        } catch (err) {
            console.error(err);
            setStatus(`Error: ${err.message}`);
        }
    };

    return (
        <div style={{ padding: '20px', maxWidth: '500px', margin: 'auto', fontFamily: 'sans-serif' }}>
            <h2>Audio Downloader</h2>
            
            <input type="text" placeholder="M3U8 URL (Required)" value={url} onChange={e => setUrl(e.target.value)} style={{ width: '100%', marginBottom: '10px', padding: '8px' }}/>
            <input type="text" placeholder="Song Title" value={title} onChange={e => setTitle(e.target.value)} style={{ width: '100%', marginBottom: '10px', padding: '8px' }}/>
            <input type="text" placeholder="Artist" value={artist} onChange={e => setArtist(e.target.value)} style={{ width: '100%', marginBottom: '10px', padding: '8px' }}/>
            <input type="text" placeholder="Album" value={album} onChange={e => setAlbum(e.target.value)} style={{ width: '100%', marginBottom: '10px', padding: '8px' }}/>
            <input type="text" placeholder="Image URL (Cover Art)" value={imageUrl} onChange={e => setImageUrl(e.target.value)} style={{ width: '100%', marginBottom: '10px', padding: '8px' }}/>
            <input type="text" placeholder="Spotify Track ID (For Lyrics)" value={trackid} onChange={e => setTrackid(e.target.value)} style={{ width: '100%', marginBottom: '10px', padding: '8px' }}/>

            <button onClick={handleDownload} disabled={!url || status.includes("Downloading") || status.includes("Converting")} style={{ width: '100%', padding: '12px', background: '#0070f3', color: 'white', border: 'none', cursor: 'pointer', fontWeight: 'bold' }}>
                Start Download
            </button>

            <div style={{ marginTop: '20px', padding: '10px', background: '#f5f5f5', borderRadius: '5px' }}>
                <strong>Status:</strong> {status}
            </div>
        </div>
    );
}
