# @fiodos/auto-manifest — motor de auto-detección (v3, AI-first)

Motor que analiza una app Expo/React Native y genera un borrador de `AppManifest`
(esquema real de `@fiodos/core`). **La IA lee el código fuente directamente** y
propone rutas y acciones con evidencia obligatoria; una verificación mecánica de
salida confirma que cada claim existe de verdad en el código antes de aceptarlo.

> v2 funcionaba al revés (detector estático de candidatos → IA solo curaba) y
> fallaba a cero cuando el detector no entendía el patrón de estado de la app
> (p. ej. React Context). En v3 la mecánica ya no es portero de entrada: solo
> revisor de salida.

## Instalación y uso (como lo hace un desarrollador)

El CLI se publica en npm como **`@fiodos/cli`** (binario `fiodos`). El comando
que el dashboard muestra para integrar el orbe en una web:

```bash
cd /ruta/a/tu/web
npx @fiodos/cli analyze . --publish --api-key fyd_xxx
```

Eso analiza el código, publica el manifest en tu proyecto Fiodos y te ofrece
cablear el orbe `<FiodosAgent/>` en tu app.

Opciones de análisis:

```bash
# Análisis alojado (POR DEFECTO): la IA corre en el backend de Fiodos con
# NUESTRA clave; no necesitas clave de IA propia. Tu código pasa por el backend
# de Fiodos de camino a la IA (ver Privacidad).
npx @fiodos/cli analyze . --publish --api-key fyd_xxx

# Clave propia (PRIVADO): la IA corre en tu máquina con TU clave; el código va
# directo a la IA y NUNCA pasa por Fiodos. Requiere ANTHROPIC_API_KEY (o
# OPENAI_API_KEY si usas --model gpt-…).
npx @fiodos/cli analyze . --publish --api-key fyd_xxx --own-ai-key

# Solo estático (sin IA): rutas, sin acciones; no se envía código a ningún sitio.
npx @fiodos/cli analyze . --publish --api-key fyd_xxx --no-llm

# Backend local (desarrollo):
npx @fiodos/cli analyze . --publish --api-key fyd_xxx --api-url http://localhost:8000
```

> Alternativa SIN IA — instalación manual: el flujo base de cualquier SDK
> siempre funciona y no requiere IA ni clave de proveedor:
> `npm install @fiodos/react @fiodos/core` y montar `<FiodosAgent/>` (el
> dashboard da los pasos). El `analyze` con IA es el extra que detecta y cablea
> las acciones automáticamente, no el único camino.

## Privacidad — léelo antes de vender esto

Sé transparente con dónde va el código en CADA modo:

1. **Publicación (`--publish`): el código NUNCA viaja.** Solo el `manifest.json`
   resultante + metadatos pequeños (motor, modelo, contadores). El endpoint de
   publicación solo acepta JSON con esquema de `AppManifest`.
2. **Análisis con IA — depende del modo:**
   - **Alojado (por defecto):** el código fuente **SÍ pasa por el backend de
     Fiodos**, que lo reenvía al proveedor de IA con **nuestra** clave. Se
     mantiene en memoria solo durante la llamada; **no se guarda ni se loguea**.
     Cómodo (sin clave propia) pero el código toca nuestros servidores.
   - **`--own-ai-key` (privado):** el código va **directo de tu máquina al
     proveedor de IA** con **tu** clave; **no toca el backend de Fiodos**. Para
     clientes sensibles (banca, salud) que no quieren que el código pase por
     nosotros.
   - **`--no-llm`:** no se envía código a ningún sitio (solo rutas estáticas).

En modo alojado, el coste del análisis lo asume Fiodos (parte de la
suscripción) y está limitado por la cuota del plan (server-side). En
`--own-ai-key`, el coste es del desarrollador (su key, su proveedor).
`files-sent.json` deja auditado exactamente qué archivos entraron en el prompt.

## Arquitectura (v3)

| Paso | Módulo | Qué hace | Rol |
| --- | --- | --- | --- |
| 1 | `src/routes.js` | Escaneo estático del árbol expo-router (grupos `(x)`, `index`, `[param]`) | Hechos baratos + ground truth del verificador |
| 2 | `src/collect.js` | Selección de archivos **por reglas** (extensión/ruta, nunca análisis): excluye deps/nativo/tests/configs; si la app excede el presupuesto (`--max-input-tokens`, 150K por defecto) prioriza pantallas→estado→servicios→UI y reporta lo omitido | No puede "fallar a cero" |
| 3 | `src/aiAnalyze.js` | **UNA llamada**: el modelo lee el código completo y propone manifest + evidencia por ítem (`{file, symbol}`) + `uncertain` | La IA lidera |
| 4 | `src/verify.js` | Revisor de salida: el archivo de evidencia debe existir entre los enviados, el handler/símbolo debe aparecer como identificador real en ese archivo, la ruta debe existir en el escaneo del paso 1. Lo no probado se **elimina** y queda en `provenance.json` | Anti-alucinación |
| 5 | core | `validateManifest` real de `@fiodos/core` | Gate final |

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
| `manifest.json` | `AppManifest` (esquema `@fiodos/core`), verificado y validado |
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
