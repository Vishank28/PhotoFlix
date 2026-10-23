// Shrinks phone videos (often 4K, 20-60 Mbps) to 1080p H.264 MP4 at ~5 Mbps so a Fire TV can
// stream them smoothly over Wi-Fi. Uses the ffmpeg binary from the ffmpeg-static package.
import { execFile } from 'child_process';
import ffmpegPath from 'ffmpeg-static';

const MAX_SIDE = 1920; // 1920x1080 landscape (fills a full-HD TV sharply), 1080x1920 portrait
const TIMEOUT_MS = 10 * 60 * 1000;

export const canShrink = !!ffmpegPath;

export function shrinkVideo(input, output) {
  // Longest side capped at MAX_SIDE; -2 keeps the other side even (required by H.264). Phones' rotation is applied first.
  const scale = "scale='if(gte(iw,ih),min(" + MAX_SIDE + ",iw),-2)':'if(gte(iw,ih),-2,min(" + MAX_SIDE + ",ih))'";
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?', // first video + first audio track; iPhones add extra metadata tracks
    '-vf', scale, '-fpsmax', '30',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-maxrate', '5000k', '-bufsize', '10000k',
    '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.0',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-movflags', '+faststart', // index at the front so playback starts before the download finishes
    '-map_metadata', '-1',
    output,
  ];
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).toString().trim().split('\n').slice(-2).join(' ')));
      else resolve();
    });
  });
}
