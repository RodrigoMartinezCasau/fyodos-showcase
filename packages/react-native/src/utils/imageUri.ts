/** iOS renders transparent PNGs more reliably from file:// than huge data: URIs. */

interface ExpoFileSystemModule {
  cacheDirectory: string;
  writeAsStringAsync: (
    uri: string,
    contents: string,
    options: { encoding: 'base64' | 'utf8' },
  ) => Promise<void>;
  EncodingType: { Base64: 'base64'; UTF8: 'utf8' };
}

let FileSystem: ExpoFileSystemModule | null = null;
try {
  FileSystem = require('expo-file-system/legacy') as ExpoFileSystemModule;
} catch {
  FileSystem = null;
}

/** RN Image only loads file/http(s) reliably — never data: on iOS. */
export function isDisplayableImageUri(uri: string | null | undefined): boolean {
  if (!uri?.trim()) return false;
  return (
    uri.startsWith('file://') ||
    uri.startsWith('http://') ||
    uri.startsWith('https://')
  );
}

export async function resolveImageDataUrlForDisplay(
  dataUrl: string | null | undefined,
  cacheFileName: string,
): Promise<string | null> {
  if (!dataUrl?.trim()) return null;
  if (dataUrl.startsWith('data:image/svg')) return null;
  if (!dataUrl.startsWith('data:')) {
    return isDisplayableImageUri(dataUrl) ? dataUrl : null;
  }

  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const base64 = dataUrl.slice(comma + 1);
  if (!FileSystem?.cacheDirectory) return null;

  try {
    const uri = `${FileSystem.cacheDirectory}${cacheFileName}`;
    await FileSystem.writeAsStringAsync(uri, base64, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return uri;
  } catch {
    return null;
  }
}
