/**
 * Theming for the SDK UI components. Every visual decision that was
 * app-branded in the source app (accent color, icon, sizes) is a prop here —
 * exactly the surface a customization dashboard will drive.
 */

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

export const DEFAULT_ORB_THEME: AgentOrbTheme = {
  size: 52,
  borderWidth: 1.5,
  accentColor: '#9aa4ff',
  backgroundColor: 'rgba(0,0,0,0.72)',
  waveformHeight: 26,
};
