export const INSTALL_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const key = 'yapyep.install.dismissed.v1';
export function installationDismissed(now = Date.now(), storage?: Pick<Storage, 'getItem'>): boolean {
  try {
    const value = Number((storage ?? localStorage).getItem(key));
    return value > 0 && now - value < INSTALL_COOLDOWN_MS;
  } catch { return false; }
}
export function dismissInstallation(storage?: Pick<Storage, 'setItem'>): void {
  try { (storage ?? localStorage).setItem(key, String(Date.now())); } catch { /* Session dismissal still works. */ }
}
export function isIosBrowser(userAgent: string, platform: string, touchPoints: number): boolean {
  return /iPad|iPhone|iPod/.test(userAgent) || platform === 'MacIntel' && touchPoints > 1;
}
