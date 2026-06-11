# @fyodos/auto-manifest — motor de auto-detección (v2)

Motor programático que analiza una app Expo/React Native de terceros y genera un borrador de `AppManifest` (esquema real de `@fyodos/core`) con **procedencia por ítem**: qué salió del análisis estático, qué decidió la IA y qué aportó el pattern.

## Uso

```bash
cd tools/auto-manifest
export OPENAI_API_KEY=sk-...
node src/index.js /ruta/a/la/app --out output/mi-app
# Solo capas estáticas (sin IA, sin patterns):
node src/index.js /ruta/a/la/app --out output/mi-app --no-llm
```

## Arquitectura (4 capas)

| Capa | Módulo | Qué hace | Procedencia |
| --- | --- | --- | --- |
| 1a | `src/routes.js` | Recorre `app/` (o `src/app/`) y deriva el árbol de rutas expo-router: grupos `(x)`, `index`, `[param]`, exclusión de `_layout`/`+not-found`/`+api` | `static` |
| 1b | `src/ast.js` | AST real con el compilador de TypeScript (no regex): handlers `handle*`/`on*`, `router.push/replace/navigate` y destinos, `Alert.alert` (+ botón `destructive`), stores Zustand (acciones vs estado), botones JSX (title ↔ onPress), `TextInput` (placeholders), `Linking.openURL`, imports | `static` |
| 2 | `src/graph.js` | Grafo de imports (resuelve `./` y `@/`), clausura transitiva por pantalla, mapeo pantalla→stores, superficie de acción consolidada con evidencia | `static` |
| 3 | `src/llm.js` | Llamadas **explícitas y logueadas** al modelo: clasificación de la app, curación de candidatos (exponer/intent/label/categoría/confirmación/parámetros/examples), naming de rutas, gap-fill del pattern | `llm` |
| 4 | `src/patterns.js` | Carga `patterns/*.md`, clasifica la app contra el catálogo y usa el pattern para proponer huecos que el código no expresa | `pattern` |

## Salvaguardas anti-alucinación (estáticas)

- Una ruta propuesta por el LLM que no existe en el escaneo del filesystem se **descarta**.
- Una acción cuyo `source_name` no corresponde a un callable detectado se **descarta** (con recuperación por matching intent↔nombre si el modelo omite el campo).
- Colisiones de intent ruta/acción se renombran determinísticamente (namespace único, como exige el validador del core).
- Tipos de parámetros se normalizan a `string|number|boolean` (deriva de esquema del LLM corregida en código).
- El manifest final se valida con el `validateManifest` real de `@fyodos/core` (gate final del pipeline).

## Salida

| Archivo | Contenido |
| --- | --- |
| `manifest.json` | `AppManifest` (esquema `@fyodos/core`), validado |
| `provenance.json` | Por cada ruta/acción (incluidas Y excluidas): detección, evidencia estática, decisión de curación, capa de patterns, resultado de validación |
| `static-facts.json` | Extracción cruda de capas 1+2 (auditable) |
| `llm-log.json` | Cada llamada LLM: tarea, latencia, tokens |

## Limitaciones conocidas

- Solo expo-router (no react-navigation puro) y solo Zustand como store (Redux/Context: no implementado).
- Handlers en closures anónimos dentro de JSX no se nombran (se capturan parcialmente vía botones).
- La curación LLM es no determinista: dos ejecuciones pueden diferir en 1-3 decisiones marginales.
- Resultado = **borrador para dashboard humano**, no manifest de producción. Ver `docs/AUTO_MANIFEST_FITNESS_EXPERIMENT_V2.md`.
