import * as blessed from 'blessed';

export interface RenderScheduler {
    /** Mark the screen dirty; render coalesces to one paint per frame. */
    schedule: () => void;
    /** Force an immediate render and reset the frame timer. */
    flush: () => void;
    /** Stop the scheduler (idempotent). */
    stop: () => void;
}

export interface RenderSchedulerOptions {
    /** Frames per second cap. Default 30. */
    fps?: number;
}

export function createRenderScheduler(
    screen: blessed.Widgets.Screen,
    opts: RenderSchedulerOptions = {},
): RenderScheduler {
    const fps = Math.max(1, Math.min(240, opts.fps ?? 120));
    const frameMs = Math.floor(1000 / fps);

    let dirty = false;
    let stopped = false;
    let timer: NodeJS.Timeout | null = null;

    const paint = (): void => {
        if (stopped) return;
        timer = null;
        if (!dirty) return;
        dirty = false;
        try {
            screen.render();
        } catch {
            /* screen may have been destroyed mid-frame */
        }
    };

    const schedule = (): void => {
        if (stopped) return;
        dirty = true;
        if (timer) return;
        timer = setTimeout(paint, frameMs);
    };

    const flush = (): void => {
        if (stopped) return;
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        dirty = false;
        try {
            screen.render();
        } catch { /* ignore */ }
    };

    const stop = (): void => {
        stopped = true;
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    };

    screen.once('destroy', stop);

    return { schedule, flush, stop };
}
