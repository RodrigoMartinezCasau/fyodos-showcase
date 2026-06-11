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
  consentAccept: 'Accept and use the assistant',
  consentDecline: 'Cancel',
  orbAccessibilityLabel: 'Voice assistant',
  orbHintIdle: 'Tap to talk to the assistant',
  orbHintListening: 'Tap to stop listening',
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
  consentAccept: 'Aceptar y usar el asistente',
  consentDecline: 'Cancelar',
  orbAccessibilityLabel: 'Asistente de voz',
  orbHintIdle: 'Pulsa para hablar con el asistente',
  orbHintListening: 'Pulsa para dejar de escuchar',
};
