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

export interface AgentOrbTheme {
  /** Orb diameter. */
  size: number;
  borderWidth: number;
  /** Accent: border, spinner and waveform color. */
  accentColor: string;
  backgroundColor: string;
  waveformHeight: number;
}

export const DEFAULT_ORB_THEME: AgentOrbTheme = {
  size: 52,
  borderWidth: 1.5,
  accentColor: '#9aa4ff',
  backgroundColor: 'rgba(0,0,0,0.72)',
  waveformHeight: 26,
};
