import React, { useEffect, useState, useRef } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import NodeID3 from 'node-id3';
import { Buffer } from 'buffer';

// Polyfill Buffer for the browser (Required for NodeID3)
if (typeof window !== 'undefined') {
    window.Buffer = window.Buffer || Buffer;
}

export default function AutoDownloader() {
    const ffmpegRef = useRef(new FFmpeg());
    const hasStarted = useRef(false); // Prevents duplicate downloads in React Strict Mode
    const [status, setStatus] = useState("Initializing Download...");
    const [progress, setProgress] = useState(0);

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

    // M3U8 Fetcher
    const downloadM3U8ToMemory = async (playlistUrl, ffmpeg) => {
        setStatus("Fetching High-Quality Stream...");
        const res = await fetch(playlistUrl);
        const text = await res.text();

        // If Master Playlist, dig deeper
        if (text.includes('#EXT-X-STREAM-INF')) {
            const lines = text.split('\n');
            let bestUrl = '';
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith('#EXT-X-STREAM-INF')) bestUrl = lines[i + 1].trim();
            }
            const absoluteUrl = new URL(bestUrl, playlistUrl).href;
            return downloadM3U8ToMemory(absoluteUrl, ffmpeg);
        }

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

        // Download segments 10 at a time for maximum speed
        for (let i = 0; i < segments.length; i += 10) {
            const batch = segments.slice(i, i + 10);
            await Promise.all(batch.map(async (seg) => {
                const r = await fetch(seg.url);
                const buf = await r.arrayBuffer();
                await ffmpeg.writeFile(seg.name, new Uint8Array(buf));
            }));
            setStatus(`Downloading Audio: ${Math.min(i + 10, segments.length)} / ${segments.length} chunks`);
            setProgress(Math.round(((i + 10) / segments.length) * 100));
        }

        await ffmpeg.writeFile('local.m3u8', localM3u8);
        return 'local.m3u8';
    };

    useEffect(() => {
        // Prevent double execution
        if (hasStarted.current) return;
        hasStarted.current = true;

        const executeDownload = async () => {
            try {
                // 1. Read parameters exactly like your API did
                const queryParams = new URLSearchParams(window.location.search);
                const url = queryParams.get("url");
                const title = queryParams.get("title") || queryParams.get("tittle") || "Unknown Title";
                const artist = queryParams.get("artist") || "Unknown Artist";
                const album = queryParams.get("album") || "Unknown Album";
                const imageUrl = queryParams.get("imageUrl");
                const trackid = queryParams.get("trackid");

                if (!url) {
                    setStatus("Error: Missing URL parameter.");
                    return;
                }

                const ffmpeg = ffmpegRef.current;

                // Load FFmpeg WASM
                if (!ffmpeg.loaded) {
                    setStatus("Loading Audio Engine...");
                    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
                    await ffmpeg.load({
                        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
                        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
                    });
                }

                // 2. Fetch Metadata (Parallel)
                setStatus("Fetching Metadata...");
                let imageBuffer = null;
                let imageMime = 'image/jpeg';
                let lyricsData = null;
                const fetchTasks = [];

                if (imageUrl) {
                    fetchTasks.push(
                        fetch(imageUrl).then(async imgRes => {
                            if (imgRes.ok) {
                                if ((imgRes.headers.get('content-type') || '').includes('png')) imageMime = 'image/png';
                                imageBuffer = Buffer.from(await imgRes.arrayBuffer());
                            }
                        }).catch(() => console.log("Cover fetch failed"))
                    );
                }

                if (trackid) {
                    fetchTasks.push(
                        fetch(`https://lyr-nine.vercel.app/api/lyrics?url=https://open.spotify.com/track/${trackid}&format=lrc`)
                            .then(async lyrRes => {
                                if (lyrRes.ok) lyricsData = await lyrRes.json();
                            }).catch(() => console.log("Lyrics fetch failed"))
                    );
                }

                await Promise.all(fetchTasks);

                // 3. Download & Process
                const m3u8Filename = await downloadM3U8ToMemory(url, ffmpeg);

                setStatus("Converting to MP3 (This may take a moment)...");
                await ffmpeg.exec([
                    '-i', m3u8Filename,
                    '-c:a', 'libmp3lame',
                    '-b:a', '320k',
                    '-compression_level', '0', 
                    '-map_metadata', '-1',
                    'output.mp3'
                ]);

                const rawMp3Data = await ffmpeg.readFile('output.mp3');
                let finalMp3Buffer = Buffer.from(rawMp3Data.buffer);

                // 4. Inject ID3 Tags
                setStatus("Embedding Lyrics & Cover Art...");
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

                if (lyricsData?.lines?.length > 0) {
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
                    id3Tags.unsynchronisedLyrics = { language: 'eng', text: rawText };
                }

                finalMp3Buffer = NodeID3.update(id3Tags, finalMp3Buffer);

                // 5. Trigger Automatic Browser Download
                setStatus("Done! File downloaded.");
                const blob = new Blob([finalMp3Buffer], { type: 'audio/mpeg' });
                const downloadUrl = URL.createObjectURL(blob);
                
                const safeFileName = title.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/ /g, "_") || "audio_download";
                
                // Creates an invisible link, clicks it, and removes it instantly
                const a = document.createElement('a');
                a.style.display = 'none';
                a.href = downloadUrl;
                a.download = `${safeFileName}.mp3`;
                document.body.appendChild(a);
                a.click();
                
                // Cleanup
                setTimeout(() => {
                    document.body.removeChild(a);
                    URL.revokeObjectURL(downloadUrl);
                }, 100);

            } catch (err) {
                console.error(err);
                setStatus(`Error: ${err.message}`);
            }
        };

        executeDownload();
    }, []);

    // Minimalist UI (Feels like a system/API page)
    return (
        <div style={{ 
            display: 'flex', 
            flexDirection: 'column', 
            alignItems: 'center', 
            justifyContent: 'center', 
            height: '100vh', 
            fontFamily: 'sans-serif',
            backgroundColor: '#fafafa',
            color: '#333'
        }}>
            <h2 style={{ marginBottom: '10px' }}>{status}</h2>
            
            {progress > 0 && progress < 100 && (
                <div style={{ width: '300px', background: '#ddd', borderRadius: '10px', overflow: 'hidden', marginTop: '20px' }}>
                    <div style={{ 
                        height: '10px', 
                        background: '#0070f3', 
                        width: `${progress}%`,
                        transition: 'width 0.2s'
                    }} />
                </div>
            )}

            {status.includes("Done") && (
                <p style={{ marginTop: '20px', color: '#666' }}>You can now close this tab.</p>
            )}
        </div>
    );
}
