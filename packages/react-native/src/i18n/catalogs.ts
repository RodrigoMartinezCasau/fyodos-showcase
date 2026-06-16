import type { AgentUiMessages } from './types';

export const uiEn: AgentUiMessages = {
  errorTitle: 'Voice assistant',
  sttTooShort: "I didn't hear you. Please try again.",
  sttNoTranscript: "I couldn't make out what you said. Tap the button and speak a bit longer.",
  sttUnavailable: 'Speech recognition is not available in this environment.',
  micPermissionDenied: 'Microphone permission is required to use the voice assistant.',
  emptyReply: 'No response was received from the assistant.',
  turnFailed: "I couldn't respond right now. Please try again.",
  sessionExpired: 'Your session has expired. Please sign in again.',
  rateLimited: 'Too many requests. Please wait a moment.',
  quotaExceeded: 'You have reached your usage limit for now.',
  noConnection: 'No connection to the server. Check your internet and try again.',
  serverUnavailable: 'The server is not available. Try again in a few seconds.',
  genericError: 'Something went wrong. Please try again.',
  confirmationSayYesNo: 'Do you confirm the action? Say yes or no.',
  confirmTitle: 'Confirm action',
  confirmLabel: 'Confirm',
  cancelLabel: 'Cancel',
  consentTitle: 'Voice assistant',
  consentBody:
    'When you use the voice assistant, the transcription of what you say, the visible ' +
    'content of the current screen and basic app context will be sent to external ' +
    'artificial intelligence providers to generate the response.',
  consentBodySecondary:
    'Your voice audio never leaves the device: transcription happens locally. ' +
    'You can revoke this consent at any time from the app settings.',
  consentBodyWakeWord:
    'If you accept, the app may listen locally for the wake phrase so you can start the assistant hands-free. Revoke microphone access for this app in system settings to disable it.',
  consentAccept: 'Accept and use the assistant',
  consentDecline: 'Cancel',
  orbAccessibilityLabel: 'Voice assistant',
  orbHintIdle: 'Tap to talk to the assistant',
  orbHintListening: 'Tap to stop listening',
  textInputPlaceholder: 'Type your question…',
  textSendLabel: 'Send',
  textPanelCloseLabel: 'Close text input',
  keyboardChipLabel: 'Type instead of talking',
  wakeWordListeningLabel: 'Voice activation listening for {phrase}',
  voiceActivationSettingsTitle: 'Voice activation',
  voiceActivationSettingsBody:
    'Say {phrase} to start the assistant without tapping the orb. ' +
    'The app listens locally for the wake phrase only — no audio is sent to ' +
    'servers until the assistant responds.',
  voiceActivationSettingsEnable: 'Enable {phrase}',
  voiceActivationSettingsDisable: 'Disable voice activation',
  voiceActivationSettingsHint:
    'Off by default. Requires assistant consent. Uses the microphone while the app is open.',
  voiceActivationSettingsUnavailable:
    'Voice activation is not available in this app. The developer can enable it from the Fiodos dashboard.',
  voiceActivationSettingsActive: 'Listening active — you will see a discreet indicator near the orb.',
  voiceActivationSettingsClose: 'Close',
};

export const uiEs: AgentUiMessages = {
  errorTitle: 'Asistente de voz',
  sttTooShort: 'No te he escuchado. Inténtalo de nuevo.',
  sttNoTranscript: 'No se ha entendido lo que dijiste. Pulsa el botón y habla un poco más.',
  sttUnavailable: 'No hay reconocimiento de voz disponible en este entorno.',
  micPermissionDenied: 'Necesitas dar permiso al micrófono para usar el asistente de voz.',
  emptyReply: 'No he recibido respuesta del asistente.',
  turnFailed: 'No pude responder ahora. Inténtalo de nuevo.',
  sessionExpired: 'Sesión expirada. Vuelve a iniciar sesión.',
  rateLimited: 'Demasiadas peticiones. Espera un momento.',
  quotaExceeded: 'Has alcanzado tu límite de uso por ahora.',
  noConnection: 'Sin conexión con el servidor. Comprueba tu internet e inténtalo de nuevo.',
  serverUnavailable: 'El servidor no está disponible. Inténtalo en unos segundos.',
  genericError: 'Ha ocurrido un error. Inténtalo de nuevo.',
  confirmationSayYesNo: '¿Confirmas la acción? Di sí o no.',
  confirmTitle: 'Confirmar acción',
  confirmLabel: 'Confirmar',
  cancelLabel: 'Cancelar',
  consentTitle: 'Asistente de voz',
  consentBody:
    'Al usar el asistente de voz, se enviará a proveedores externos de inteligencia ' +
    'artificial la transcripción de lo que digas, el contenido visible de la pantalla ' +
    'actual y datos básicos de contexto de la app, necesarios para generar la respuesta.',
  consentBodySecondary:
    'El audio de tu voz no sale del dispositivo: la transcripción se realiza localmente. ' +
    'Puedes revocar este consentimiento en cualquier momento desde los ajustes de la app.',
  consentBodyWakeWord:
    'Si aceptas, la app podrá escuchar localmente la frase de activación para iniciar el asistente sin tocar la pantalla. Revoca el acceso al micrófono de esta app en los ajustes del sistema para desactivarlo.',
  consentAccept: 'Aceptar y usar el asistente',
  consentDecline: 'Cancelar',
  orbAccessibilityLabel: 'Asistente de voz',
  orbHintIdle: 'Pulsa para hablar con el asistente',
  orbHintListening: 'Pulsa para dejar de escuchar',
  textInputPlaceholder: 'Escribe tu consulta…',
  textSendLabel: 'Enviar',
  textPanelCloseLabel: 'Cerrar entrada de texto',
  keyboardChipLabel: 'Escribir en lugar de hablar',
  wakeWordListeningLabel: 'Activación por voz escuchando {phrase}',
  voiceActivationSettingsTitle: 'Activación por voz',
  voiceActivationSettingsBody:
    'Di {phrase} para iniciar el asistente sin pulsar el orbe. La app escucha ' +
    'localmente solo la palabra de activación; ningún audio se envía a servidores ' +
    'hasta que el asistente responda.',
  voiceActivationSettingsEnable: 'Activar {phrase}',
  voiceActivationSettingsDisable: 'Desactivar activación por voz',
  voiceActivationSettingsHint:
    'Desactivada por defecto. Requiere consentimiento del asistente. Usa el micrófono con la app abierta.',
  voiceActivationSettingsUnavailable:
    'Esta función no está disponible. El desarrollador puede activarla desde el panel de Fiodos.',
  voiceActivationSettingsActive: 'Escucha activa — verás un indicador discreto junto al orbe.',
  voiceActivationSettingsClose: 'Volver',
};
