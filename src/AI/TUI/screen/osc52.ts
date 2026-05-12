/**
 * Best-effort "copy to system clipboard" for the TUI yank command.
 *
 * blessed runs inside an alt-screen TTY, possibly inside a tmux pane; relying
 * solely on OSC 52 was unreliable for the user (escapes get eaten by tmux
 * unless `set -g set-clipboard on` is set, and Apple Terminal ignores OSC 52
 * entirely). So we try, in order:
 *
 *   1. A platform-native CLI (`pbcopy` on macOS, `wl-copy` / `xclip` /
 *      `xsel` on Linux, `clip.exe` on Windows). This always lands in the
 *      real system clipboard if the binary exists.
 *   2. OSC 52, wrapped in tmux's DCS passthrough when `$TMUX` is set so the
 *      escape reaches the host terminal. Written to the controlling TTY
 *      directly (`/dev/tty`) — bypassing blessed's stdout buffering — to
 *      avoid the byte being mid-stream of a render frame.
 *
 * Both paths are attempted so OSC 52 still works on remote/SSH sessions
 * even when no CLI helper exists.
 */

import { spawnSync } from 'child_process';
import { openSync, writeSync, closeSync } from 'fs';

const MAX_OSC52_BYTES = 100_000;

interface ClipboardCandidate {
    cmd: string;
    args: string[];
}

const candidatesForPlatform = (): ClipboardCandidate[] => {
    if (process.platform === 'darwin') {
        return [{ cmd: 'pbcopy', args: [] }];
    }
    if (process.platform === 'win32') {
        return [{ cmd: 'clip.exe', args: [] }];
    }
    // Linux / *BSD: prefer Wayland, then X11.
    const list: ClipboardCandidate[] = [];
    if (process.env.WAYLAND_DISPLAY) list.push({ cmd: 'wl-copy', args: [] });
    list.push({ cmd: 'xclip', args: ['-selection', 'clipboard'] });
    list.push({ cmd: 'xsel', args: ['--clipboard', '--input'] });

    return list;
};

const tryNativeClipboard = (text: string): boolean => {
    for (const { cmd, args } of candidatesForPlatform()) {
        try {
            const res = spawnSync(cmd, args, { input: text, encoding: 'utf8' });
            if (res.status === 0 && !res.error) return true;
        } catch {
            /* try next */
        }
    }

    return false;
};

const writeToTty = (payload: string): void => {
    // Write directly to the controlling TTY so the escape does NOT race
    // blessed's render frame on stdout.
    let fd: number | null = null;
    try {
        fd = openSync('/dev/tty', 'w');
        writeSync(fd, payload);
    } catch {
        try { process.stdout.write(payload); } catch { /* ignore */ }
    } finally {
        if (fd !== null) {
            try { closeSync(fd); } catch { /* ignore */ }
        }
    }
};

const sendOsc52 = (text: string): void => {
    const truncated = Buffer.byteLength(text, 'utf8') > MAX_OSC52_BYTES
        ? text.slice(0, MAX_OSC52_BYTES)
        : text;
    const b64 = Buffer.from(truncated, 'utf8').toString('base64');
    const inner = `\x1b]52;c;${b64}\x07`;
    // tmux requires DCS passthrough so the OSC reaches the host terminal.
    const payload = process.env.TMUX
        ? `\x1bPtmux;\x1b${inner}\x1b\\`
        : inner;
    writeToTty(payload);
};

export function copyViaOsc52(text: string): void {
    if (!text) return;
    // Prefer the platform-native clipboard helper. Falling back to OSC 52
    // ONLY when the native helper isn't available avoids the
    // "clipboard appends instead of replaces" effect users hit when
    // both a local pbcopy AND a tmux DCS-passthrough OSC 52 land in
    // the host clipboard at slightly different times.
    if (tryNativeClipboard(text)) return;
    sendOsc52(text);
}
