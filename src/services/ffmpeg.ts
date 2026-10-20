import { existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Locate an ffmpeg executable for `bc_record`. Nothing is bundled (same policy as
 * the browser: a system install, found where people actually put it), and the
 * error names the three ways to get one.
 *
 * Order: `BC_FFMPEG` (explicit, must exist) -> `ffmpeg` on PATH -> known install
 * locations: the binary `pip install imageio-ffmpeg` drops into a per-user
 * Python, a `winget install Gyan.FFmpeg` package, the classic `C:\ffmpeg`, and
 * the usual Unix prefixes.
 */

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => {
      try { return statSync(join(dir, n)).isDirectory(); } catch { return false; }
    });
  } catch {
    return [];
  }
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => {
      try { return statSync(join(dir, n)).isFile(); } catch { return false; }
    });
  } catch {
    return [];
  }
}

/** Executables to probe, in preference order. Exported for the unit test. */
export function ffmpegCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const localAppData = env.LOCALAPPDATA;
  if (localAppData) {
    // pip install imageio-ffmpeg -> ...\Python3xx\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe
    const pythons = join(localAppData, 'Programs', 'Python');
    for (const v of listDirs(pythons)) {
      const bin = join(pythons, v, 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries');
      for (const f of listFiles(bin)) if (/^ffmpeg.*\.exe$/i.test(f)) out.push(join(bin, f));
    }
    // winget install Gyan.FFmpeg -> ...\WinGet\Packages\Gyan.FFmpeg_<hash>\ffmpeg-<ver>-full_build\bin\ffmpeg.exe
    const winget = join(localAppData, 'Microsoft', 'WinGet', 'Packages');
    for (const pkg of listDirs(winget)) {
      if (!/ffmpeg/i.test(pkg)) continue;
      for (const sub of listDirs(join(winget, pkg))) out.push(join(winget, pkg, sub, 'bin', 'ffmpeg.exe'));
    }
  }
  out.push(
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/opt/homebrew/bin/ffmpeg',
  );
  return out;
}

function runsFromPath(cmd: string): boolean {
  const r = spawnSync(cmd, ['-version'], { stdio: 'ignore' });
  return !r.error;
}

export const FFMPEG_MISSING_HINT =
  'bc_record needs ffmpeg to encode the video. Install it (`winget install Gyan.FFmpeg`, or `pip install imageio-ffmpeg`, '
  + 'or apt/brew `ffmpeg`) or set BC_FFMPEG to the executable path.';

/** Path (or bare command) of a working ffmpeg. Throws with install instructions when there is none. */
export function resolveFfmpeg(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.BC_FFMPEG;
  if (override) {
    if (!existsSync(override)) throw new Error(`BC_FFMPEG points to a missing file: ${override}`);
    return override;
  }
  if (runsFromPath('ffmpeg')) return 'ffmpeg';
  const found = ffmpegCandidates(env).find((c) => existsSync(c));
  if (!found) throw new Error(`No ffmpeg found. ${FFMPEG_MISSING_HINT}`);
  return found;
}
