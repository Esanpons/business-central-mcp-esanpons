import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Screencast — a CDP `Page.startScreencast` stream piped into ffmpeg at a FIXED
 * frame rate, in wall-clock time.
 *
 * Why not puppeteer's own `page.screencast()`: it writes each captured frame as
 * many times as `round(fps * (t - tPrev))`, per frame. A cursor moving at ~60 Hz
 * hands it gaps of 16 ms, which round to 0 copies, and the gaps between them
 * round up; measured on devel1 the result was a 24.4 s file for 20.5 s of real
 * time, so the timeline (what happened when) no longer matched the picture. It
 * also encodes VP9 only, which meant a second pass to get an MP4 people can open.
 *
 * Here Chrome pushes JPEG frames whenever the page repaints, the newest one is
 * kept, and a scheduler writes the newest frame to ffmpeg exactly `fps` times per
 * second of elapsed time (sample-and-hold). A still page costs nothing but
 * repeated identical frames, a busy one never drifts, and `elapsedMs()` is the
 * same clock the timeline is stamped with. ffmpeg encodes straight to H.264
 * (or VP9 for webm) in one pass.
 */

export interface ScreencastOptions {
  /** ffmpeg executable (path or bare command). */
  ffmpeg: string;
  /** Output file; the extension must match `format`. */
  path: string;
  width: number;
  height: number;
  fps: number;
  format: 'mp4' | 'webm';
  /** JPEG quality of the captured frames, 0-100 (default 90). */
  quality?: number;
}

export interface ScreencastStats {
  durationMs: number;
  /** Frames written to the encoder (= durationMs * fps / 1000, rounded). */
  frames: number;
  /** Frames Chrome actually pushed (repaints). */
  captured: number;
}

/** The ffmpeg command line for one container. Exported for the unit test. */
export function encoderArgs(opts: Pick<ScreencastOptions, 'fps' | 'format' | 'path'>): string[] {
  const codec = opts.format === 'mp4'
    ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
    : ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '0', '-crf', '32'];
  return [
    '-y', '-loglevel', 'error',
    '-f', 'image2pipe', '-vcodec', 'mjpeg', '-framerate', String(opts.fps), '-i', 'pipe:0',
    // yuv420p needs even dimensions (an odd viewport would fail the encode), and
    // JPEG frames are full-range: convert to limited range so the file is tagged
    // plain yuv420p, which every player handles, instead of yuvj420p.
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2:out_range=tv,format=yuv420p',
    ...codec,
    '-r', String(opts.fps), '-an',
    opts.path,
  ];
}

export class Screencast {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;
  private proc!: ChildProcess;
  private latest?: Buffer;
  private captured = 0;
  private written = 0;
  private t0 = 0;
  private timer?: NodeJS.Timeout;
  private stderr = '';
  private exited?: Promise<number | null>;
  private readonly frameMs: number;

  private constructor(private readonly opts: ScreencastOptions) {
    this.frameMs = 1000 / opts.fps;
  }

  /**
   * Start capturing `page`. Resolves once Chrome has delivered the first frame
   * (so the video starts with a picture, not black) and the clock is running.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static async start(page: any, opts: ScreencastOptions): Promise<Screencast> {
    const sc = new Screencast(opts);
    await sc.begin(page);
    return sc;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async begin(page: any): Promise<void> {
    this.proc = spawn(this.opts.ffmpeg, encoderArgs(this.opts), { stdio: ['pipe', 'ignore', 'pipe'] });
    this.proc.stderr!.on('data', (d: Buffer) => { this.stderr += d.toString('utf8'); });
    this.exited = new Promise<number | null>((resolve) => {
      this.proc.on('error', (e) => { this.stderr += ` (spawn: ${e.message})`; resolve(-1); });
      this.proc.on('close', (code) => resolve(code));
    });
    // A closed pipe (ffmpeg died) must not crash the process on the next write.
    this.proc.stdin!.on('error', () => undefined);

    this.client = await page.createCDPSession();
    this.client.on('Page.screencastFrame', (ev: { data: string; sessionId: number }) => {
      this.latest = Buffer.from(ev.data, 'base64');
      this.captured++;
      this.client.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => undefined);
    });
    await this.client.send('Page.startScreencast', {
      format: 'jpeg',
      quality: this.opts.quality ?? 90,
      maxWidth: this.opts.width,
      maxHeight: this.opts.height,
      everyNthFrame: 1,
    });

    // Wait for the first repaint; the caller usually just drew something.
    const deadline = Date.now() + 5000;
    while (!this.latest && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    if (!this.latest) {
      await this.abort();
      throw new Error('The page produced no frames in 5 s: nothing to record.');
    }

    this.t0 = Date.now();
    // Tick at half a frame so a frame is never more than half a frame late.
    this.timer = setInterval(() => this.flush(Date.now()), this.frameMs / 2);
  }

  /** Write the newest frame once for every frame period that has elapsed. */
  private flush(now: number): void {
    const due = Math.floor((now - this.t0) / this.frameMs);
    const stdin = this.proc.stdin;
    if (!stdin || stdin.destroyed || !this.latest) return;
    while (this.written < due) {
      stdin.write(this.latest);
      this.written++;
    }
  }

  /** Milliseconds since the first frame: the clock a timeline is stamped with. */
  elapsedMs(): number {
    return Date.now() - this.t0;
  }

  /** Stop capturing, finish the file, and report what was written. Throws if ffmpeg failed. */
  async stop(): Promise<ScreencastStats> {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    const end = Date.now();
    this.flush(end);
    await this.client?.send('Page.stopScreencast').catch(() => undefined);
    await this.client?.detach().catch(() => undefined);
    this.proc.stdin?.end();
    const code = await this.exited;
    if (code !== 0) {
      throw new Error(
        `ffmpeg failed to encode the video (exit ${code}): ${this.stderr.trim() || 'no output'}. `
        + 'If this build of ffmpeg lacks libx264, pass format:"webm".',
      );
    }
    return { durationMs: end - this.t0, frames: this.written, captured: this.captured };
  }

  /** Tear everything down without caring about the file (error paths). */
  async abort(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    await this.client?.send('Page.stopScreencast').catch(() => undefined);
    await this.client?.detach().catch(() => undefined);
    try { this.proc.stdin?.end(); } catch { /* already closed */ }
    try { this.proc.kill(); } catch { /* already gone */ }
    await this.exited;
  }
}
