/**
 * '@fiodos/react-native/expo' — adapters over the Expo stack. Importing this
 * entry requires: expo, expo-audio, expo-asset, expo-file-system, expo-speech,
 * expo-router (for the navigation adapter) and
 * @react-native-async-storage/async-storage.
 */
export { createExpoVoiceAdapter } from './expoVoiceAdapter';
export type { ExpoVoiceAdapterOptions } from './expoVoiceAdapter';
export {
  createExpoRouterNavigationAdapter,
  ExpoRouterRouteTracker,
} from './expoRouterNavigation';
export type {
  ExpoRouterAdapterOptions,
  ExpoRouterNavigationAdapter,
} from './expoRouterNavigation';
export { createAsyncStorageAdapter } from './asyncStorage';

// High-level one-line orb mount (the RN counterpart of the web <FiodosAgent/>).
export { FiodosExpoAgent } from './FiodosExpoAgent';
export type { FiodosExpoAgentProps } from './FiodosExpoAgent';
