import { useState, useEffect } from 'react';

// Define the BeforeInstallPromptEvent interface
interface BeforeInstallPromptEvent extends Event {
    readonly platforms: string[];
    readonly userChoice: Promise<{
        outcome: 'accepted' | 'dismissed';
        platform: string;
    }>;
    prompt(): Promise<void>;
}

export const InstallPrompt = () => {
    const [isIOS, setIsIOS] = useState(false);
    const [isStandalone, setIsStandalone] = useState(false);
    const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
    const [showBanner, setShowBanner] = useState(false);

    useEffect(() => {
        // 1. Check if already installed (Standalone)
        const isStandaloneMode = window.matchMedia('(display-mode: standalone)').matches ||
            (window.navigator as any).standalone === true;

        setIsStandalone(isStandaloneMode);
        if (isStandaloneMode) return;

        // 2. Detect iOS
        const userAgent = window.navigator.userAgent.toLowerCase();
        const isIosDevice = /iphone|ipad|ipod/.test(userAgent);
        setIsIOS(isIosDevice);

        // 3. Listen for Android/Desktop install prompt
        const handleBeforeInstallPrompt = (e: Event) => {
            e.preventDefault();
            setDeferredPrompt(e as BeforeInstallPromptEvent);
            setShowBanner(true);
        };

        window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

        // 4. Show iOS banner after a delay if not standalone
        if (isIosDevice) {
            const timer = setTimeout(() => setShowBanner(true), 2000);
            return () => clearTimeout(timer);
        }

        return () => {
            window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
        };
    }, []);

    const handleInstallClick = async () => {
        if (!deferredPrompt) return;

        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;

        if (outcome === 'accepted') {
            setDeferredPrompt(null);
            setShowBanner(false);
        }
    };

    if (isStandalone || !showBanner) return null;

    return (
        <div className="fixed bottom-4 left-4 right-4 bg-[#1e1e38] border border-[#646cff] p-4 rounded-xl shadow-2xl z-50 animate-slide-up flex flex-col gap-3">
            <div className="flex justify-between items-start">
                <div>
                    <h3 className="text-white font-bold text-lg">Install Fusion Share</h3>
                    <p className="text-gray-300 text-sm mt-1">
                        Add to home screen for a better experience.
                    </p>
                </div>
                <button
                    onClick={() => setShowBanner(false)}
                    className="text-gray-400 hover:text-white p-1"
                >
                    ✕
                </button>
            </div>

            {isIOS ? (
                <div className="text-sm text-gray-300 bg-[#2a2a40] p-3 rounded-lg">
                    Tap <span className="inline-block px-2 text-blue-400">Share</span> then
                    <br />
                    <span className="font-bold text-white">Add to Home Screen ⊞</span>
                </div>
            ) : (
                <button
                    onClick={handleInstallClick}
                    className="w-full py-2 bg-[#646cff] hover:bg-[#535bf2] text-white font-semibold rounded-lg transition-colors"
                >
                    Install App
                </button>
            )}
        </div>
    );
};
