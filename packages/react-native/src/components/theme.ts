/**
 * Theming for the SDK UI components. Every visual decision that was
 * app-branded in the source app (accent color, icon, sizes) is a prop here —
 * exactly the surface a customization dashboard will drive.
 */
import { FYODOS_DEFAULT_ORB_THEME, FYODOS_DEFAULT_KEYBOARD_CHIP } from '@fiodos/core';

export interface AgentModalTheme {
  backdropColor: string;
  cardBackgroundColor: string;
  cardBorderColor: string;
  titleColor: string;
  bodyColor: string;
  primaryButtonColor: string;
  primaryLabelColor: string;
  secondaryButtonColor: string;
  secondaryLabelColor: string;
  /** Text bubble corner radius (dashboard-driven). */
  borderRadius?: number;
  /** Send button corner radius. */
  sendButtonRadius?: number;
}

export const DEFAULT_MODAL_THEME: AgentModalTheme = {
  backdropColor: 'rgba(0,0,0,0.6)',
  cardBackgroundColor: '#16181d',
  cardBorderColor: 'rgba(255,255,255,0.14)',
  titleColor: '#fff',
  bodyColor: 'rgba(255,255,255,0.82)',
  primaryButtonColor: '#fff',
  primaryLabelColor: '#000',
  secondaryButtonColor: 'rgba(255,255,255,0.08)',
  secondaryLabelColor: 'rgba(255,255,255,0.85)',
};

export interface KeyboardChipTheme {
  size?: number;
  shape?: 'circle' | 'rounded' | 'square';
  backgroundColor?: string;
  borderColor?: string;
  iconColor?: string;
  icon?: 'keyboard' | 'pen' | 'chat';
  iconImageDataUrl?: string | null;
  iconScale?: number;
  innerBorderColor?: string;
  innerBorderWidth?: number;
  /** 0–100 outer accent border thickness. */
  borderWidth?: number;
}

export interface AgentOrbTheme {
  /** Orb diameter. */
  size: number;
  borderWidth: number;
  /** Accent: border, spinner. */
  accentColor: string;
  /** Listening waveform bar color (dashboard-driven). */
  waveformColor?: string;
  /** Optional rim glow (dashboard glowColor / glowKey). */
  glowColor?: string;
  backgroundColor: string;
  /** Dashboard colorKey — persisted for reference. */
  colorKey?: string;
  glowKey?: string;
  /** Rim spin speed 0–100 (dashboard speed). */
  speed?: number;
  /** Rim glow strength 0–100. */
  glowIntensity?: number;
  /** Inner hairline ring (dashboard). */
  innerBorderColor?: string;
  innerBorderWidth?: number;
  waveformHeight: number;
  /** Optional overrides for the keyboard chip (dashboard-driven). */
  keyboardChip?: Partial<KeyboardChipTheme>;
}

// Derived from the SINGLE SOURCE OF TRUTH in @fiodos/core so the app's default
// orb is identical to the dashboard preview's default orb (brand blue, neutral
// mark, same keyboard chip). Do not hardcode brand values here.
export const DEFAULT_ORB_THEME: AgentOrbTheme = {
  size: FYODOS_DEFAULT_ORB_THEME.size,
  borderWidth: FYODOS_DEFAULT_ORB_THEME.borderWidth,
  accentColor: FYODOS_DEFAULT_ORB_THEME.accentColor,
  glowColor: FYODOS_DEFAULT_ORB_THEME.glowColor,
  backgroundColor: FYODOS_DEFAULT_ORB_THEME.backgroundColor,
  colorKey: FYODOS_DEFAULT_ORB_THEME.colorKey,
  glowKey: FYODOS_DEFAULT_ORB_THEME.glowKey,
  speed: FYODOS_DEFAULT_ORB_THEME.speed,
  glowIntensity: FYODOS_DEFAULT_ORB_THEME.glowIntensity,
  innerBorderColor: FYODOS_DEFAULT_ORB_THEME.innerBorderColor,
  innerBorderWidth: FYODOS_DEFAULT_ORB_THEME.innerBorderWidth,
  waveformColor: FYODOS_DEFAULT_ORB_THEME.waveformColor,
  waveformHeight: FYODOS_DEFAULT_ORB_THEME.waveformHeight,
  keyboardChip: { ...FYODOS_DEFAULT_KEYBOARD_CHIP },
};
