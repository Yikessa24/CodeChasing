const SENSITIVE_DIRECTORIES = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube']);
const SENSITIVE_EXACT_FILES = new Set([
  '.env',
  'credentials.json',
  'service-account.json',
  'service_account.json',
  'id_rsa',
  'id_ed25519'
]);

/** Prevents model-directed repository tools from discovering common credential files. */
export function isSensitiveWorkspacePath(value: string): boolean {
  const normalized = value.trim().replace(/\\/g, '/').toLowerCase();
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => SENSITIVE_DIRECTORIES.has(segment))) {
    return true;
  }
  const basename = segments.at(-1) ?? '';
  return (
    SENSITIVE_EXACT_FILES.has(basename) ||
    basename.startsWith('.env.') ||
    /^secrets?(?:\.|$)/.test(basename) ||
    /^service[-_]account.*\.json$/.test(basename) ||
    /\.(?:pem|key|p12|pfx|jks|keystore)$/.test(basename)
  );
}
