# @fyodos/auto-manifest — motor de auto-detección (v3, AI-first)

Motor que analiza una app Expo/React Native y genera un borrador de `AppManifest`
(esquema real de `@fyodos/core`). **La IA lee el código fuente directamente** y
propone rutas y acciones con evidencia obligatoria; una verificación mecánica de
salida confirma que cada claim existe de verdad en el código antes de aceptarlo.

> v2 funcionaba al revés (detector estático de candidatos → IA solo curaba) y
> fallaba a cero cuando el detector no entendía el patrón de estado de la app
> (p. ej. React Context). En v3 la mecánica ya no es portero de entrada: solo
> revisor de salida.

## Uso

```bash
cd tools/auto-manifest
node src/index.js /ruta/a/la/app --out output/mi-app

# Elegir modelo (por defecto gpt-5; la calidad de evidencia importa más que el céntimo):
node src/index.js /ruta/a/la/app --out output/mi-app --model gpt-5-mini

# Pasada solo estática (gratis, sin enviar código a la IA — solo rutas, sin acciones):
node src/index.js /ruta/a/la/app --out output/mi-app --no-llm

# Publicar el resultado en tu proyecto Fyodos (dashboard → "Recargar análisis"):
node src/index.js /ruta/a/la/app --out output/mi-app \
  --publish --api-url http://localhost:8000
```

Las keys se cargan solas desde `tools/auto-manifest/.env` y `fyodos/backend/.env`
(el export del shell tiene prioridad). Al publicar, se usa la
`EXPO_PUBLIC_FYODOS_API_KEY` del `.env` de la app analizada si existe.

## Privacidad — léelo antes de vender esto

Dos fronteras distintas, sé transparente con ambas:

1. **Backend de Fyodos: el código NUNCA llega.** Con `--publish` solo viaja el
   `manifest.json` resultante + metadatos pequeños (motor, modelo, contadores,
   coste). El endpoint solo acepta JSON con esquema de `AppManifest` y rechaza
   payloads grandes. No existe ningún endpoint capaz de recibir código.
2. **Proveedor de IA: el código SÍ se envía durante el análisis.** Para que la
   IA lea el código, los archivos fuente recopilados se mandan a la API de
   OpenAI **con la key del propio desarrollador** (`OPENAI_API_KEY`), una vez
   por análisis. Es el mismo modelo que cualquier herramienta de IA sobre
   código, pero debe figurar en la política de privacidad y mencionarse a
   clientes sensibles (banca, salud…). Para esos casos: `--no-llm` da una
   pasada solo estática sin enviar nada, y a futuro cabe un modelo local/privado.

El coste del análisis lo asume quien analiza (su key, su proveedor).
`files-sent.json` deja auditado exactamente qué archivos se enviaron.

## Arquitectura (v3)

| Paso | Módulo | Qué hace | Rol |
| --- | --- | --- | --- |
| 1 | `src/routes.js` | Escaneo estático del árbol expo-router (grupos `(x)`, `index`, `[param]`) | Hechos baratos + ground truth del verificador |
| 2 | `src/collect.js` | Selección de archivos **por reglas** (extensión/ruta, nunca análisis): excluye deps/nativo/tests/configs; si la app excede el presupuesto (`--max-input-tokens`, 150K por defecto) prioriza pantallas→estado→servicios→UI y reporta lo omitido | No puede "fallar a cero" |
| 3 | `src/aiAnalyze.js` | **UNA llamada**: el modelo lee el código completo y propone manifest + evidencia por ítem (`{file, symbol}`) + `uncertain` | La IA lidera |
| 4 | `src/verify.js` | Revisor de salida: el archivo de evidencia debe existir entre los enviados, el handler/símbolo debe aparecer como identificador real en ese archivo, la ruta debe existir en el escaneo del paso 1. Lo no probado se **elimina** y queda en `provenance.json` | Anti-alucinación |
| 5 | core | `validateManifest` real de `@fyodos/core` | Gate final |

## Salvaguardas anti-alucinación

- El prompt exige evidencia (`file` + `symbol`) por cada acción y prohíbe
  explícitamente "acciones que apps así suelen tener".
- El verificador mecánico descarta cualquier acción cuyo archivo o símbolo no
  exista de verdad, y cualquier ruta fuera del escaneo del filesystem.
- Una acción descartada queda registrada con su motivo en `provenance.json` —
  nunca se publica.
- Intents duplicados ruta/acción se resuelven determinísticamente; tipos de
  parámetros se normalizan a `string|number|boolean`.
- Resultado medido en QuickBite: 8/8 acciones reales detectadas, 8/8 con
  evidencia verificada, 0 alucinadas (v2 detectaba 0).

## Coste real medido (junio 2026, gpt-5)

| App | Archivos | Tokens entrada | Coste |
| --- | --- | --- | --- |
| QuickBite | 36 | ~23K | **$0.09** |
| aarnote | 24 | ~19K | $0.09 |
| finance-mobile | 65 | ~23K | $0.08 |
| styk | 98 | ~50K | $0.15 |

Céntimos por análisis, una vez, pagados por el desarrollador con su key.

## Salida

| Archivo | Contenido |
| --- | --- |
| `manifest.json` | `AppManifest` (esquema `@fyodos/core`), verificado y validado |
| `provenance.json` | Por cada ruta/acción: verificación superada o motivo de descarte |
| `evidence.json` | Evidencia declarada por el modelo + sus dudas (`uncertain`) |
| `usage.json` | Tokens reales de la API + coste en USD del análisis |
| `files-sent.json` | Exactamente qué archivos entraron en el prompt (y cuáles se omitieron) |

## Limitaciones conocidas

- Solo expo-router (no react-navigation puro).
- Apps muy grandes: lo que exceda el presupuesto de entrada se omite por
  prioridad y el modelo lo declara en `uncertain` (sube el presupuesto con
  `--max-input-tokens` si lo necesitas).
- La salida del modelo es no determinista: dos ejecuciones pueden diferir en
  decisiones marginales (labels, examples).
- Resultado = **borrador para revisión humana en el dashboard**, no manifest de
  producción.
