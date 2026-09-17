import { useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { dismissInstallation, installationDismissed, isIosBrowser } from '../lib/pwa';

interface InstallEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** Mount once in the app shell. Eligibility follows a useful journey interaction. */
export default function PwaControls({ eligible }: { eligible: boolean }) {
  const [install, setInstall] = useState<InstallEvent | null>(null);
  const [standalone, setStandalone] = useState(() => window.matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
  const [dismissed, setDismissed] = useState(() => installationDismissed());
  const [instructions, setInstructions] = useState(false);
  const [offline, setOffline] = useState(() => !navigator.onLine);
  const [error, setError] = useState('');
  const [installing, setInstalling] = useState(false);
  const { needRefresh: [needRefresh, setNeedRefresh], updateServiceWorker } = useRegisterSW({
    onRegisterError: () => setError('Offline setup is unavailable right now. You can keep using YapYep online.'),
  });
  const ios = isIosBrowser(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
  useEffect(() => {
    const deferred = (event: Event) => { event.preventDefault(); setInstall(event as InstallEvent); };
    const installed = () => { setStandalone(true); setInstall(null); setInstructions(false); };
    const network = () => setOffline(!navigator.onLine);
    const media = window.matchMedia('(display-mode: standalone)');
    const display = () => setStandalone(media.matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
    window.addEventListener('beforeinstallprompt', deferred);
    window.addEventListener('appinstalled', installed);
    window.addEventListener('online', network); window.addEventListener('offline', network);
    media.addEventListener('change', display);
    return () => {
      window.removeEventListener('beforeinstallprompt', deferred);
      window.removeEventListener('appinstalled', installed);
      window.removeEventListener('online', network); window.removeEventListener('offline', network);
      media.removeEventListener('change', display);
    };
  }, []);
  function later() { dismissInstallation(); setDismissed(true); setInstructions(false); }
  async function installApp() {
    if (!install || installing) return;
    setInstalling(true); setError('');
    try {
      await install.prompt();
      const choice = await install.userChoice;
      if (choice.outcome === 'dismissed') later();
    } catch { setError('Installation did not finish. Try again from your browser menu.'); }
    finally { setInstall(null); setInstalling(false); }
  }
  const offer = eligible && !standalone && !dismissed && (install || ios);
  if (!offline && !needRefresh && !offer && !error) return null;
  return <aside aria-label="YapYep app availability" className="shrink-0 border-t border-line bg-surface px-4 py-2 text-[12px] text-ink">
    {offline && <p role="status">You’re offline. The app shell can open after your first online visit. Live AI, sign-in and sharing need a connection; this does not mean changes were saved.</p>}
    {needRefresh && <div className="flex flex-wrap items-center gap-x-3">
      <p>A new YapYep version is ready. Finish and save your work before updating.</p>
      <button type="button" className="min-h-[44px] font-semibold text-primary" onClick={() => { void updateServiceWorker(true).catch(() => setError('The update did not finish. Please try again later.')); }}>Update and reload</button>
      <button type="button" className="min-h-[44px] text-muted" onClick={() => setNeedRefresh(false)}>Later</button>
    </div>}
    {!needRefresh && offer && <div className="flex flex-wrap items-center gap-x-3">
      <p>Keep Yep close — add YapYep to your home screen.</p>
      <button type="button" disabled={installing} className="min-h-[44px] font-semibold text-primary" onClick={() => install ? void installApp() : setInstructions(!instructions)}>{installing ? 'Opening…' : ios && !install ? 'How to install' : 'Install YapYep'}</button>
      <button type="button" className="min-h-[44px] text-muted" onClick={later}>Not now</button>
      {instructions && <p className="w-full pb-2">In Safari, open Share → Add to Home Screen → Add. If this browser has no Add to Home Screen option, open YapYep in Safari first.</p>}
    </div>}
    {error && <div className="flex items-center gap-2"><p role="status">{error}</p><button type="button" aria-label="Dismiss availability message" className="min-h-[44px] px-2 text-muted" onClick={() => setError('')}>Dismiss</button></div>}
  </aside>;
}
