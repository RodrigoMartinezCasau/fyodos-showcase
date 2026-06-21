/**
 * StorageAdapter over @react-native-async-storage/async-storage.
 * Under '/expo' so Metro only resolves the package when used.
 */
import type { StorageAdapter } from '@fiodos/core';

interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AsyncStorage = (
  require('@react-native-async-storage/async-storage') as { default: AsyncStorageLike }
).default;

export function createAsyncStorageAdapter(): StorageAdapter {
  return {
    getItem: (key) => AsyncStorage.getItem(key),
    setItem: (key, value) => AsyncStorage.setItem(key, value),
    removeItem: (key) => AsyncStorage.removeItem(key),
  };
}
