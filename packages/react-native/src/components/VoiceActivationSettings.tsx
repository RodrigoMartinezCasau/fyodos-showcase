import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import { useFyodosRuntime } from '../provider/FyodosProvider';
import { useVoiceActivationOptIn } from '../voice/useVoiceActivationOptIn';

export interface VoiceActivationSettingsProps {
  /** Called when the user taps an optional back/close control. */
  onClose?: () => void;
  closeLabel?: string;
  style?: ViewStyle;
  /** Accent for the switch track when enabled. */
  accentColor?: string;
}

/**
 * Optional settings block for integrators who want an in-app wake-word toggle.
 * Not included by default — users can revoke via system microphone settings.
 */
export function VoiceActivationSettings({
  onClose,
  closeLabel,
  style,
  accentColor = '#3f7bff',
}: VoiceActivationSettingsProps) {
  const { config, ui } = useFyodosRuntime();
  const { optedIn, loading, setOptedIn } = useVoiceActivationOptIn();
  const va = config.voiceActivation;

  if (!va?.developerEnabled) {
    return (
      <View style={[styles.container, style]}>
        <Text style={styles.title}>{ui.voiceActivationSettingsTitle}</Text>
        <Text style={styles.body}>{ui.voiceActivationSettingsUnavailable}</Text>
        {onClose ? (
          <Pressable style={styles.button} onPress={onClose}>
            <Text style={styles.buttonLabel}>{closeLabel ?? ui.voiceActivationSettingsClose}</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <View style={[styles.container, style]}>
      <Text style={styles.title}>{ui.voiceActivationSettingsTitle}</Text>
      <Text style={styles.body}>{ui.voiceActivationSettingsBody.replace('{phrase}', va.displayPhrase ?? '…')}</Text>
      <View style={styles.row}>
        <View style={styles.rowText}>
          <Text style={styles.rowTitle}>{va.displayPhrase ?? '…'}</Text>
          <Text style={styles.rowHint}>{ui.voiceActivationSettingsHint}</Text>
        </View>
        {loading ? (
          <ActivityIndicator color={accentColor} />
        ) : (
          <Switch
            value={optedIn}
            onValueChange={(v) => void setOptedIn(v)}
            trackColor={{ false: '#444', true: accentColor }}
            thumbColor="#fff"
            accessibilityLabel={ui.voiceActivationSettingsEnable.replace('{phrase}', va.displayPhrase ?? '…')}
          />
        )}
      </View>
      {optedIn ? <Text style={styles.status}>{ui.voiceActivationSettingsActive}</Text> : null}
      {onClose ? (
        <Pressable style={styles.button} onPress={onClose}>
          <Text style={styles.buttonLabel}>{closeLabel ?? ui.voiceActivationSettingsClose}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20 },
  title: { fontSize: 22, fontWeight: '700', color: '#f0f3fa', marginBottom: 12 },
  body: { fontSize: 14, color: '#aab4cc', lineHeight: 21 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 20,
    padding: 14,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  rowText: { flex: 1, paddingRight: 12 },
  rowTitle: { color: '#e7ecf7', fontWeight: '600', fontSize: 16, marginBottom: 6 },
  rowHint: { color: '#8a96b4', fontSize: 13, lineHeight: 18 },
  status: { marginTop: 14, fontSize: 13, color: '#2a7a4b', lineHeight: 18 },
  button: {
    marginTop: 24,
    padding: 14,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
  },
  buttonLabel: { color: '#e7ecf7', fontWeight: '600' },
});
