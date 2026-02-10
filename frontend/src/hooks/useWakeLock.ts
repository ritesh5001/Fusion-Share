import { useRef, useState, useEffect, useCallback } from 'react';

/**
 * useWakeLock – best-effort screen wake lock for active file transfers.
 *
 * - Feature-detects the Wake Lock API; silently no-ops if unavailable.
 * - Handles visibility changes: releases on hidden, re-acquires on visible.
 * - All promise rejections are safely caught — never blocks calling code.
 */
export function useWakeLock() {
    const wakeLockRef = useRef<WakeLockSentinel | null>(null);
    const [isActive, setIsActive] = useState(false);
    const isRequestedRef = useRef(false); // tracks whether wake lock is logically wanted
    const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;

    const log = (message: string) => {
        console.log(`[FusionShare][WakeLock] ${message}`);
    };

    // Acquire the wake lock
    const acquire = useCallback(async () => {
        if (!supported) return;
        if (wakeLockRef.current) return; // already held

        try {
            wakeLockRef.current = await navigator.wakeLock.request('screen');
            setIsActive(true);
            log('acquired');

            // Listen for the browser releasing the lock (e.g. low battery)
            wakeLockRef.current.addEventListener('release', () => {
                wakeLockRef.current = null;
                setIsActive(false);
                log('released by system');
            });
        } catch (err) {
            // Silently handle — e.g. user denied permission, low battery, etc.
            log(`request failed: ${(err as Error).message}`);
            wakeLockRef.current = null;
            setIsActive(false);
        }
    }, [supported]);

    // Release the wake lock
    const release = useCallback(async () => {
        isRequestedRef.current = false;

        if (wakeLockRef.current) {
            try {
                await wakeLockRef.current.release();
                log('released');
            } catch {
                // Already released or failed — safe to ignore
            }
            wakeLockRef.current = null;
            setIsActive(false);
        }
    }, []);

    // Public request: marks as requested + acquires
    const request = useCallback(() => {
        if (!supported) {
            log('not supported');
            return;
        }
        isRequestedRef.current = true;
        acquire();
    }, [supported, acquire]);

    // Visibility change handler: release when hidden, re-acquire when visible
    useEffect(() => {
        if (!supported) return;

        const handleVisibilityChange = () => {
            if (document.visibilityState === 'hidden') {
                // Release lock when page becomes hidden
                if (wakeLockRef.current) {
                    wakeLockRef.current.release().catch(() => { });
                    wakeLockRef.current = null;
                    setIsActive(false);
                    log('released (page hidden)');
                }
            } else if (document.visibilityState === 'visible') {
                // Re-acquire only if transfer is still active
                if (isRequestedRef.current && !wakeLockRef.current) {
                    log('re-acquiring (page visible)');
                    acquire();
                }
            }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [supported, acquire]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (wakeLockRef.current) {
                wakeLockRef.current.release().catch(() => { });
                wakeLockRef.current = null;
            }
        };
    }, []);

    return { request, release, isActive };
}
